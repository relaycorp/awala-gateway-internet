import {
  Certificate,
  HandshakeChallenge,
  HandshakeResponse,
  NONCE_SIGNATURE,
  ParcelDelivery,
} from '@relaycorp/relaynet-core';
import AbortController from 'abort-controller';
import bufferToArray from 'buffer-to-arraybuffer';
import { IncomingMessage } from 'http';
import pipe from 'it-pipe';
import { Logger } from 'pino';
import { duplex } from 'stream-to-it';
import uuid from 'uuid-random';
import WebSocket, { createWebSocketStream, Server as WSServer } from 'ws';

import { createMongooseConnectionFromEnv } from '../../backingServices/mongo';
import { NatsStreamingClient } from '../../backingServices/natsStreaming';
import { retrieveOwnCertificates } from '../certs';
import { ParcelStore, ParcelStreamMessage } from '../parcelStore';
import { WebSocketCode } from './websockets';

interface PendingACK {
  readonly ack: () => Promise<void>;
  readonly parcelObjectKey: string;
}

export default function (requestIdHeader: string, baseLogger: Logger): WSServer {
  const wsServer = new WSServer({ noServer: true });

  wsServer.on('connection', makeConnectionHandler(requestIdHeader, baseLogger));

  return wsServer;
}

function makeConnectionHandler(
  requestIdHeader: string,
  baseLogger: Logger,
): (ws: WebSocket, request: IncomingMessage) => void {
  const parcelStore = ParcelStore.initFromEnv();

  return async (wsConnection, request) => {
    const reqId = (request.headers[requestIdHeader] as string | undefined) ?? uuid();
    const requestAwareLogger = baseLogger.child({ reqId });
    requestAwareLogger.debug('Starting parcel collection request');

    if (request.headers.origin) {
      requestAwareLogger.debug('Denying web browser request');
      wsConnection.close(
        WebSocketCode.VIOLATED_POLICY,
        'Web browser requests are disabled for security reasons',
      );
      return;
    }

    const abortController = new AbortController();
    wsConnection.once('close', (closeCode, closeReason) => {
      requestAwareLogger.info({ closeCode, closeReason }, 'Closing connection');
      abortController.abort();
    });
    wsConnection.once('error', (err) => {
      requestAwareLogger.info({ err }, 'Closing connection due to error');
      abortController.abort();
    });

    // "on" or any value other than "off" should keep the connection alive
    const keepAlive = request.headers['x-relaynet-keep-alive'] !== 'off';

    const nonce = bufferToArray(uuid.bin() as Buffer);

    wsConnection.once('message', async (message) => {
      // tslint:disable-next-line:no-let
      let handshakeResponse: HandshakeResponse;
      try {
        handshakeResponse = HandshakeResponse.deserialize(message as ArrayBuffer);
      } catch (err) {
        requestAwareLogger.info({ err }, 'Refusing malformed handshake response');
        wsConnection.close(WebSocketCode.CANNOT_ACCEPT, 'Invalid handshake response');
        return;
      }

      const nonceSignaturesCount = handshakeResponse.nonceSignatures.length;
      if (nonceSignaturesCount !== 1) {
        requestAwareLogger.info(
          { nonceSignaturesCount },
          'Refusing handshake response with invalid number of signatures',
        );
        wsConnection.close(
          WebSocketCode.CANNOT_ACCEPT,
          'Handshake response did not include exactly one nonce signature ' +
            `(got ${nonceSignaturesCount})`,
        );
        return;
      }

      const mongooseConnection = await createMongooseConnectionFromEnv();
      const trustedCertificates = await retrieveOwnCertificates(mongooseConnection);
      // noinspection ES6MissingAwait
      mongooseConnection.close();

      // tslint:disable-next-line:no-let
      let peerGatewayCertificate: Certificate;
      try {
        peerGatewayCertificate = await NONCE_SIGNATURE.verify(
          handshakeResponse.nonceSignatures[0],
          nonce,
          trustedCertificates,
        );
      } catch (err) {
        requestAwareLogger.info({ err }, 'Refusing handshake response with invalid signature');
        wsConnection.close(WebSocketCode.CANNOT_ACCEPT, 'Nonce signature is invalid');
        return;
      }

      const peerGatewayAddress = await peerGatewayCertificate.calculateSubjectPrivateAddress();
      const peerAwareLogger = requestAwareLogger.child({ peerGatewayAddress });

      peerAwareLogger.debug('Handshake completed successfully');

      const stream = createWebSocketStream(wsConnection);
      const connectionDuplex = duplex(stream);

      // tslint:disable-next-line:readonly-keyword
      const pendingACKs: { [key: string]: PendingACK } = {};
      // tslint:disable-next-line:no-let
      let allParcelsDelivered = false;

      async function processAcknowledgements(ackMessages: AsyncIterable<string>): Promise<void> {
        for await (const ackMessage of ackMessages) {
          const pendingACK = pendingACKs[ackMessage];
          if (!pendingACK) {
            peerAwareLogger.info('Closing connection due to unknown acknowledgement');
            wsConnection.close(
              WebSocketCode.CANNOT_ACCEPT,
              'Unknown delivery id sent as acknowledgement',
            );
            break;
          }
          // tslint:disable-next-line:no-delete no-object-mutation
          delete pendingACKs[ackMessage];
          peerAwareLogger.info(
            { parcelObjectKey: pendingACK.parcelObjectKey },
            'Acknowledgement received',
          );
          await pendingACK.ack();

          if (Object.keys(pendingACKs).length === 0 && allParcelsDelivered) {
            peerAwareLogger.info('Closing connection after all parcels have been acknowledged');
            wsConnection.close(WebSocketCode.NORMAL);
            break;
          }
        }
      }

      const activeParcelsForGateway = streamActiveParcels(
        keepAlive,
        parcelStore,
        peerGatewayAddress,
        peerAwareLogger,
        reqId,
        abortController.signal,
      );

      async function* streamDeliveries(
        parcelMessages: AsyncIterable<ParcelStreamMessage>,
      ): AsyncIterable<Buffer> {
        for await (const parcelMessage of parcelMessages) {
          peerAwareLogger.info(
            { parcelObjectKey: parcelMessage.parcelObjectKey },
            'Sending parcel',
          );
          const parcelDelivery = new ParcelDelivery(
            uuid(),
            bufferToArray(parcelMessage.parcelSerialized),
          );

          // tslint:disable-next-line:no-object-mutation
          pendingACKs[parcelDelivery.deliveryId] = {
            ack: parcelMessage.ack,
            parcelObjectKey: parcelMessage.parcelObjectKey,
          };

          yield Buffer.from(parcelDelivery.serialize());
        }
        allParcelsDelivered = true;

        if (Object.keys(pendingACKs).length === 0) {
          peerAwareLogger.info('All parcels were acknowledged shortly after the last one was sent');
          wsConnection.close(WebSocketCode.NORMAL);
        }
      }

      await pipe(
        activeParcelsForGateway,
        streamDeliveries,
        connectionDuplex,
        processAcknowledgements,
      );
    });

    requestAwareLogger.debug('Sending handshake challenge');
    const challenge = new HandshakeChallenge(nonce);
    wsConnection.send(challenge.serialize());
  };
}

function streamActiveParcels(
  keepAlive: boolean,
  parcelStore: ParcelStore,
  peerGatewayAddress: string,
  logger: Logger,
  requestId: string,
  abortSignal: AbortSignal,
): AsyncIterable<ParcelStreamMessage> {
  if (!keepAlive) {
    return parcelStore.streamActiveParcelsForGateway(peerGatewayAddress, logger);
  }
  const natsStreamingClient = NatsStreamingClient.initFromEnv(`parcel-collection-${requestId}`);
  return parcelStore.liveStreamActiveParcelsForGateway(
    peerGatewayAddress,
    natsStreamingClient,
    abortSignal,
    logger,
  );
}
