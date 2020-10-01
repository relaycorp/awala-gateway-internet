import {
  Certificate,
  HandshakeChallenge,
  HandshakeResponse,
  NONCE_SIGNATURE,
  ParcelDelivery,
} from '@relaycorp/relaynet-core';
import AbortController from 'abort-controller';
import bufferToArray from 'buffer-to-arraybuffer';
import { Logger } from 'pino';
import uuid from 'uuid-random';
import { Server as WSServer } from 'ws';

import { createMongooseConnectionFromEnv } from '../../backingServices/mongo';
import { NatsStreamingClient } from '../../backingServices/natsStreaming';
import { retrieveOwnCertificates } from '../certs';
import { ParcelStore, ParcelStreamMessage } from '../parcelStore';
import { WebSocketCode } from './websockets';

export default function (requestIdHeader: string, baseLogger: Logger): WSServer {
  const wsServer = new WSServer({ noServer: true });

  const parcelStore = ParcelStore.initFromEnv();

  wsServer.on('connection', async (wsConnection, request) => {
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

    // "on" or any value other than "off" should keep the connection alive
    const keepAlive = request.headers['x-relaynet-keep-alive'] !== 'off';

    const nonce = bufferToArray(uuid.bin() as Buffer);

    const mongooseConnection = await createMongooseConnectionFromEnv();
    wsConnection.on('close', () => mongooseConnection.close());

    wsConnection.once('message', async (message: ArrayBuffer) => {
      // tslint:disable-next-line:no-let
      let handshakeResponse: HandshakeResponse;
      try {
        handshakeResponse = HandshakeResponse.deserialize(message);
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

      const trustedCertificates = await retrieveOwnCertificates(mongooseConnection);
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
      const abortController = new AbortController();
      const activeParcelsForGateway = streamActiveParcels(
        keepAlive,
        parcelStore,
        peerGatewayAddress,
        peerAwareLogger,
        reqId,
        abortController.signal,
      );
      for await (const parcelMessage of activeParcelsForGateway) {
        const parcelDelivery = new ParcelDelivery(
          uuid(),
          bufferToArray(parcelMessage.parcelSerialized),
        );
        wsConnection.send(Buffer.from(parcelDelivery.serialize()));
      }
      wsConnection.close(WebSocketCode.NORMAL);
    });

    requestAwareLogger.debug('Sending handshake challenge');
    const challenge = new HandshakeChallenge(nonce);
    wsConnection.send(challenge.serialize());
  });

  return wsServer;
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
