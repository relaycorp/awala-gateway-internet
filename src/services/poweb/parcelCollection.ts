import {
  Certificate,
  HandshakeChallenge,
  HandshakeResponse,
  ParcelCollectionHandshakeVerifier,
  ParcelDelivery,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { type FastifyBaseLogger, FastifyInstance } from 'fastify';
import { IncomingHttpHeaders, IncomingMessage, Server as HTTPServer } from 'http';
import { Connection } from 'mongoose';
import { pipeline, writeToStream } from 'streaming-iterables';
import uuid from 'uuid-random';
import WebSocket, {
  createWebSocketStream,
  Server as WSServer,
  ServerOptions as WSServerOptions,
} from 'ws';

import { ParcelStore, ParcelStreamMessage } from '../../parcelStore';
import { retrieveOwnCertificates } from '../../pki';
import { WebSocketCode } from './websockets';
import { RedisPubSubClient } from '../../backingServices/RedisPubSubClient';

/**
 * Maximum size of each incoming message.
 *
 * ACK messages are tiny, but HandshakeResponse messages contain digital signatures with their
 * respective signers' certificates. Keeping in mind that each certificate takes up around 1.9 kib
 * and a private gateway could have 2-3 valid certificates (whilst order certificates are being
 * rotated out), we should allow 6 kib.
 */
export const PARCEL_COLLECTION_MAX_PAYLOAD_OCTETS = 6 * 1024;

const WEBSOCKET_PING_INTERVAL_MS = 5_000;

interface PendingACK {
  readonly ack: () => Promise<void>;
  readonly parcelObjectKey: string;
}

export default async function (
  fastify: FastifyInstance,
  _options: any,
  done: () => void,
): Promise<void> {
  const fastifyTypeless = fastify as any;
  makeWebSocketServer(
    fastifyTypeless.mongoose,
    fastifyTypeless.initialConfig.requestIdHeader,
    fastify.log,
    fastify.server,
  );
  done();
}

export function makeWebSocketServer(
  mongooseConnection: Connection,
  requestIdHeader: string,
  baseLogger: FastifyBaseLogger,
  httpServer?: HTTPServer,
): WSServer {
  const serverOptions: Partial<WSServerOptions> = httpServer
    ? { server: httpServer }
    : { noServer: true };
  const wsServer = new WSServer({
    clientTracking: false,
    maxPayload: PARCEL_COLLECTION_MAX_PAYLOAD_OCTETS,
    path: '/v1/parcel-collection',
    ...serverOptions,
  });
  const redisPubSubClient = RedisPubSubClient.init();

  wsServer.on(
    'connection',
    makeConnectionHandler(mongooseConnection, redisPubSubClient, requestIdHeader, baseLogger),
  );

  return wsServer;
}

function makeConnectionHandler(
  mongooseConnection: Connection,
  redisPubSubClient: RedisPubSubClient,
  requestIdHeader: string,
  baseLogger: FastifyBaseLogger,
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

    const pingIntervalId = setInterval(() => {
      requestAwareLogger.debug('Sending ping to client');
      wsConnection.ping();
    }, WEBSOCKET_PING_INTERVAL_MS);
    wsConnection.once('close', () => {
      clearInterval(pingIntervalId);
    });

    const abortController = makeAbortController(wsConnection, requestAwareLogger);

    const privatePeerId = await doHandshake(wsConnection, mongooseConnection, requestAwareLogger);
    if (!privatePeerId) {
      return;
    }
    const peerAwareLogger = requestAwareLogger.child({ privatePeerId });
    peerAwareLogger.debug('Handshake completed successfully');

    const tracker = new CollectionTracker();

    const wsStream = createWebSocketStream(wsConnection);
    const outgoingPipeline = pipeline(
      () =>
        streamActiveParcels(
          parcelStore,
          privatePeerId,
          peerAwareLogger,
          redisPubSubClient,
          request.headers,
          abortController.signal,
          tracker,
        ),
      makeDeliveryStream(wsConnection, tracker, peerAwareLogger),
      writeToStream(wsStream),
    );
    const incomingPipeline = pipeline(
      () => wsStream,
      makeACKProcessor(wsConnection, tracker, peerAwareLogger),
    );
    await Promise.all([outgoingPipeline, incomingPipeline]);
  };
}

function makeAbortController(wsConnection: WebSocket, logger: FastifyBaseLogger): AbortController {
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

async function doHandshake(
  wsConnection: WebSocket,
  mongooseConnection: Connection,
  logger: FastifyBaseLogger,
): Promise<string | null> {
  const nonce = bufferToArray(uuid.bin() as Buffer);

  return new Promise((resolve) => {
    wsConnection.once('message', async (message: Buffer) => {
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

      const trustedCertificates = await retrieveOwnCertificates(mongooseConnection);

      const nonceVerifier = new ParcelCollectionHandshakeVerifier(trustedCertificates);
      let privatePeerCertificate: Certificate;
      try {
        privatePeerCertificate = await nonceVerifier.verify(
          handshakeResponse.nonceSignatures[0],
          nonce,
        );
      } catch (err) {
        logger.info({ err }, 'Refusing handshake response with invalid signature');
        wsConnection.close(WebSocketCode.CANNOT_ACCEPT, 'Nonce signature is invalid');
        return resolve(null);
      }

      resolve(await privatePeerCertificate.calculateSubjectId());
    });

    logger.debug('Sending handshake challenge');
    const challenge = new HandshakeChallenge(nonce);
    wsConnection.send(challenge.serialize());
  });
}

async function* streamActiveParcels(
  parcelStore: ParcelStore,
  privatePeerId: string,
  logger: FastifyBaseLogger,
  redisPubSubClient: RedisPubSubClient,
  requestHeaders: IncomingHttpHeaders,
  abortSignal: AbortSignal,
  tracker: CollectionTracker,
): AsyncIterable<ParcelStreamMessage> {
  // "keep-alive" or any value other than "close-upon-completion" should keep the connection alive
  const keepAlive = requestHeaders['x-relaynet-streaming-mode'] !== 'close-upon-completion';

  if (keepAlive) {
    try {
      yield* parcelStore.liveStreamParcelsForPrivatePeer(
        privatePeerId,
        redisPubSubClient,
        abortSignal,
        logger,
      );
    } catch (err) {
      logger.error({ err }, 'Failed to live stream parcels');
      tracker.setCloseFrameCode(WebSocketCode.SERVER_ERROR);
    }
  } else {
    yield* parcelStore.streamParcelsForPrivatePeer(privatePeerId, logger);
  }
}

function makeDeliveryStream(
  wsConnection: WebSocket,
  tracker: CollectionTracker,
  logger: FastifyBaseLogger,
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
      wsConnection.close(tracker.closeFrameCode);
    }
  };
}

function makeACKProcessor(
  wsConnection: WebSocket,
  tracker: CollectionTracker,
  logger: FastifyBaseLogger,
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
        wsConnection.close(tracker.closeFrameCode);
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
  // tslint:disable-next-line:readonly-keyword
  private _closeFrameCode: WebSocketCode | null = null;

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

  public setCloseFrameCode(code: WebSocketCode): void {
    // tslint:disable-next-line:no-object-mutation
    this._closeFrameCode = code;
  }

  get closeFrameCode(): WebSocketCode {
    return this._closeFrameCode ?? WebSocketCode.NORMAL;
  }
}
