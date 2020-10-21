import {
  Certificate,
  DETACHED_SIGNATURE_TYPES,
  HandshakeChallenge,
  HandshakeResponse,
  ParcelDelivery,
} from '@relaycorp/relaynet-core';
import AbortController from 'abort-controller';
import bufferToArray from 'buffer-to-arraybuffer';
import { FastifyInstance } from 'fastify';
import { IncomingHttpHeaders, IncomingMessage, Server as HTTPServer } from 'http';
import pipe from 'it-pipe';
import { Logger } from 'pino';
import { duplex } from 'stream-to-it';
import uuid from 'uuid-random';
import WebSocket, {
  createWebSocketStream,
  Server as WSServer,
  ServerOptions as WSServerOptions,
} from 'ws';

import { createMongooseConnectionFromEnv } from '../../backingServices/mongo';
import { NatsStreamingClient } from '../../backingServices/natsStreaming';
import { retrieveOwnCertificates } from '../certs';
import { ParcelStore, ParcelStreamMessage } from '../parcelStore';
import { WebSocketCode } from './websockets';

// The largest payload the client could send is the handshake response, which should be < 1.9 kib
const MAX_PAYLOAD = 2 * 1024;

interface PendingACK {
  readonly ack: () => Promise<void>;
  readonly parcelObjectKey: string;
}

export default async function (
  fastify: FastifyInstance,
  _options: any,
  done: () => void,
): Promise<void> {
  const requestIdHeader = (fastify as any).initialConfig.requestIdHeader;
  makeWebSocketServer(requestIdHeader, fastify.log as Logger, fastify.server);
  done();
}

export function makeWebSocketServer(
  requestIdHeader: string,
  baseLogger: Logger,
  httpServer?: HTTPServer,
): WSServer {
  const serverOptions: Partial<WSServerOptions> = httpServer
    ? { server: httpServer }
    : { noServer: true };
  const wsServer = new WSServer({
    clientTracking: false,
    maxPayload: MAX_PAYLOAD,
    path: '/v1/parcel-collection',
    ...serverOptions,
  });

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
    const abortController = makeAbortController(wsConnection, requestAwareLogger);

    const peerGatewayAddress = await doHandshake(wsConnection, requestAwareLogger);
    if (!peerGatewayAddress) {
      return;
    }
    const peerAwareLogger = requestAwareLogger.child({ peerGatewayAddress });
    peerAwareLogger.debug('Handshake completed successfully');

    const tracker = new CollectionTracker();

    await pipe(
      streamActiveParcels(
        parcelStore,
        peerGatewayAddress,
        peerAwareLogger,
        reqId,
        request.headers,
        abortController.signal,
      ),
      makeDeliveryStream(wsConnection, tracker, peerAwareLogger),
      duplex(createWebSocketStream(wsConnection)),
      makeACKProcessor(wsConnection, tracker, peerAwareLogger),
    );
  };
}

function makeAbortController(wsConnection: WebSocket, logger: Logger): AbortController {
  const abortController = new AbortController();
  wsConnection.once('close', (closeCode, closeReason) => {
    logger.info({ closeCode, closeReason }, 'Closing connection');
    abortController.abort();
  });
  wsConnection.once('error', (err) => {
    logger.info({ err }, 'Closing connection due to error');
    abortController.abort();
  });
  return abortController;
}

async function doHandshake(wsConnection: WebSocket, logger: Logger): Promise<string | null> {
  const nonce = bufferToArray(uuid.bin() as Buffer);

  return new Promise((resolve) => {
    wsConnection.once('message', async (message: Buffer) => {
      // tslint:disable-next-line:no-let
      let handshakeResponse: HandshakeResponse;
      try {
        handshakeResponse = HandshakeResponse.deserialize(bufferToArray(message));
      } catch (err) {
        logger.info({ err }, 'Refusing malformed handshake response');
        wsConnection.close(WebSocketCode.CANNOT_ACCEPT, 'Invalid handshake response');
        return resolve(null);
      }

      const nonceSignaturesCount = handshakeResponse.nonceSignatures.length;
      if (nonceSignaturesCount !== 1) {
        logger.info(
          { nonceSignaturesCount },
          'Refusing handshake response with invalid number of signatures',
        );
        wsConnection.close(
          WebSocketCode.CANNOT_ACCEPT,
          'Handshake response did not include exactly one nonce signature ' +
            `(got ${nonceSignaturesCount})`,
        );
        return resolve(null);
      }

      const mongooseConnection = await createMongooseConnectionFromEnv();
      const trustedCertificates = await retrieveOwnCertificates(mongooseConnection);
      // noinspection ES6MissingAwait
      mongooseConnection.close();

      // tslint:disable-next-line:no-let
      let peerGatewayCertificate: Certificate;
      try {
        peerGatewayCertificate = await DETACHED_SIGNATURE_TYPES.NONCE.verify(
          handshakeResponse.nonceSignatures[0],
          nonce,
          trustedCertificates,
        );
      } catch (err) {
        logger.info({ err }, 'Refusing handshake response with invalid signature');
        wsConnection.close(WebSocketCode.CANNOT_ACCEPT, 'Nonce signature is invalid');
        return resolve(null);
      }

      resolve(await peerGatewayCertificate.calculateSubjectPrivateAddress());
    });

    logger.debug('Sending handshake challenge');
    const challenge = new HandshakeChallenge(nonce);
    wsConnection.send(challenge.serialize());
  });
}

function streamActiveParcels(
  parcelStore: ParcelStore,
  peerGatewayAddress: string,
  logger: Logger,
  requestId: string,
  requestHeaders: IncomingHttpHeaders,
  abortSignal: AbortSignal,
): AsyncIterable<ParcelStreamMessage> {
  // "keep-alive" or any value other than "close-upon-completion" should keep the connection alive
  const keepAlive = requestHeaders['x-relaynet-streaming-mode'] !== 'close-upon-completion';

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

function makeDeliveryStream(
  wsConnection: WebSocket,
  tracker: CollectionTracker,
  logger: Logger,
): (parcelMessages: AsyncIterable<ParcelStreamMessage>) => AsyncIterable<Buffer> {
  return async function* (
    parcelMessages: AsyncIterable<ParcelStreamMessage>,
  ): AsyncIterable<Buffer> {
    for await (const parcelMessage of parcelMessages) {
      logger.info({ parcelObjectKey: parcelMessage.parcelObjectKey }, 'Sending parcel');
      const parcelDelivery = new ParcelDelivery(
        uuid(),
        bufferToArray(parcelMessage.parcelSerialized),
      );

      tracker.addPendingACK(parcelDelivery.deliveryId, {
        ack: parcelMessage.ack,
        parcelObjectKey: parcelMessage.parcelObjectKey,
      });

      yield Buffer.from(parcelDelivery.serialize());
    }
    tracker.markAllParcelsDelivered();

    if (tracker.isCollectionComplete) {
      logger.info('All parcels were acknowledged shortly after the last one was sent');
      wsConnection.close(WebSocketCode.NORMAL);
    }
  };
}

function makeACKProcessor(
  wsConnection: WebSocket,
  tracker: CollectionTracker,
  logger: Logger,
): (ackMessages: AsyncIterable<string>) => Promise<void> {
  return async (ackMessages: AsyncIterable<string>) => {
    for await (const ackMessage of ackMessages) {
      const pendingACK = tracker.popPendingACK(ackMessage);
      if (!pendingACK) {
        logger.info('Closing connection due to unknown acknowledgement');
        wsConnection.close(
          WebSocketCode.CANNOT_ACCEPT,
          'Unknown delivery id sent as acknowledgement',
        );
        break;
      }
      logger.info({ parcelObjectKey: pendingACK.parcelObjectKey }, 'Acknowledgement received');
      await pendingACK.ack();

      if (tracker.isCollectionComplete) {
        logger.info('Closing connection after all parcels have been acknowledged');
        wsConnection.close(WebSocketCode.NORMAL);
        break;
      }
    }
  };
}

class CollectionTracker {
  // tslint:disable-next-line:readonly-keyword
  private wereAllParcelsDelivered = false;
  // tslint:disable-next-line:readonly-keyword
  private pendingACKs: { [key: string]: PendingACK } = {};

  get isCollectionComplete(): boolean {
    return this.wereAllParcelsDelivered && Object.keys(this.pendingACKs).length === 0;
  }

  public markAllParcelsDelivered(): void {
    // tslint:disable-next-line:no-object-mutation
    this.wereAllParcelsDelivered = true;
  }

  public addPendingACK(deliveryId: string, pendingACK: PendingACK): void {
    // tslint:disable-next-line:no-object-mutation
    this.pendingACKs[deliveryId] = pendingACK;
  }

  public popPendingACK(deliveryId: string): PendingACK | undefined {
    const pendingACK = this.pendingACKs[deliveryId];
    if (pendingACK) {
      // tslint:disable-next-line:no-delete no-object-mutation
      delete this.pendingACKs[deliveryId];
    }
    return pendingACK;
  }
}
