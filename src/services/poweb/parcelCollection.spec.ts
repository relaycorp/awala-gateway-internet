import {
  CMSError,
  DETACHED_SIGNATURE_TYPES,
  HandshakeChallenge,
  HandshakeResponse,
  InvalidMessageError,
  ParcelDelivery,
  Signer,
} from '@relaycorp/relaynet-core';
import { MockWebSocketClient, MockWebSocketConnection } from '@relaycorp/ws-mock';
import AbortController from 'abort-controller';
import bufferToArray from 'buffer-to-arraybuffer';
import { EventEmitter } from 'events';
import { Connection } from 'mongoose';
import uuid from 'uuid-random';
import WS, { Server as WSServer } from 'ws';

import {
  arrayBufferFrom,
  arrayToAsyncIterable,
  makeMockLogging,
  MockLogging,
  mockSpy,
  partialPinoLog,
  partialPinoLogger,
  UUID4_REGEX,
} from '../../_test_utils';
import * as mongo from '../../backingServices/mongo';
import { NatsStreamingClient } from '../../backingServices/natsStreaming';
import { expectBuffersToEqual, getMockInstance } from '../_test_utils';
import * as certs from '../certs';
import { ParcelStore, ParcelStreamMessage } from '../parcelStore';
import { setUpCommonFixtures } from './_test_utils';
import { makeWebSocketServer } from './parcelCollection';
import { WebSocketCode } from './websockets';

const REQUEST_ID_HEADER = 'X-Request';

const getFixtures = setUpCommonFixtures();

let mockWSServer: WSServer;
let mockLogging: MockLogging;
beforeEach(() => {
  mockLogging = makeMockLogging();
  mockWSServer = makeWebSocketServer(REQUEST_ID_HEADER, mockLogging.logger);
});

let nonceSigner: Signer;
let peerGatewayAddress: string;
beforeAll(async () => {
  const fixtures = getFixtures();
  nonceSigner = new Signer(fixtures.privateGatewayCert, fixtures.privateGatewayPrivateKey);
  peerGatewayAddress = await fixtures.privateGatewayCert.calculateSubjectPrivateAddress();
});

const MOCK_MONGOOSE_CONNECTION: Connection = { close: mockSpy(jest.fn()) } as any;
const MOCK_MONGOOSE_CONNECTION_CREATION = mockSpy(
  jest.spyOn(mongo, 'createMongooseConnectionFromEnv'),
  jest.fn().mockResolvedValue(MOCK_MONGOOSE_CONNECTION),
);
const MOCK_RETRIEVE_OWN_CERTIFICATES = mockSpy(
  jest.spyOn(certs, 'retrieveOwnCertificates'),
  async (connection) => {
    expect(connection).toBe(MOCK_MONGOOSE_CONNECTION);
    const fixtures = getFixtures();
    return [fixtures.publicGatewayCert];
  },
);

let MOCK_PARCEL_STORE: ParcelStore;
beforeEach(() => {
  const fixtures = getFixtures();
  MOCK_PARCEL_STORE = fixtures.parcelStore;
});

const MOCK_NATS_STREAMING_CLIENT = new NatsStreamingClient(null as any, null as any, null as any);
jest.spyOn(NatsStreamingClient, 'initFromEnv').mockReturnValue(MOCK_NATS_STREAMING_CLIENT);

const parcelSerialization = Buffer.from('This is supposed to be a RAMF serialization');

mockSpy(jest.spyOn(WS, 'createWebSocketStream'), (ws: MockWebSocketConnection) => ws.makeDuplex());

describe('WebSocket server configuration', () => {
  test('Path should be /v1/parcel-collection', () => {
    const wsServer = makeWebSocketServer(REQUEST_ID_HEADER, mockLogging.logger);

    expect(wsServer.options.path).toEqual('/v1/parcel-collection');
  });

  test('Maximum incoming payload size should be 2 kib', () => {
    const wsServer = makeWebSocketServer(REQUEST_ID_HEADER, mockLogging.logger);

    expect(wsServer.options.maxPayload).toEqual(2 * 1024);
  });

  test('Clients should not be tracked', () => {
    const wsServer = makeWebSocketServer(REQUEST_ID_HEADER, mockLogging.logger);

    expect(wsServer.options.clientTracking).toBeFalse();
  });
});

describe('Request id', () => {
  test('Existing request id should be honored if present in request headers', async () => {
    const reqId = '123-id';
    const client = new MockPoWebClient(mockWSServer, 'off', 'origin', reqId);

    await client.connect();
    await client.waitForClose();

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('debug', 'Starting parcel collection request', { reqId }),
    );
  });

  test('Request id should be generated if not present in request headers', async () => {
    const client = new MockPoWebClient(mockWSServer, 'off', 'origin');

    await client.connect();
    await client.waitForClose();

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('debug', 'Starting parcel collection request', {
        reqId: UUID4_REGEX,
      }),
    );
  });
});

test('Requests with Origin header should be refused', async () => {
  const client = new MockPoWebClient(mockWSServer, 'off', 'https://invalid.local');

  await client.connect();

  await expect(client.waitForClose()).resolves.toEqual({
    code: WebSocketCode.VIOLATED_POLICY,
    reason: 'Web browser requests are disabled for security reasons',
  });
  expect(mockLogging.logs).toContainEqual(
    partialPinoLog('debug', 'Denying web browser request', { reqId: expect.anything() }),
  );
});

describe('Handshake', () => {
  test('Challenge should be sent as soon as client connects', async () => {
    const uuidBinSpy = jest.spyOn(uuid, 'bin');
    const client = new MockPoWebClient(mockWSServer);
    await client.connect();

    const challengeSerialized = await client.receive();
    expect(challengeSerialized).toBeInstanceOf(ArrayBuffer);
    const challenge = HandshakeChallenge.deserialize(challengeSerialized as ArrayBuffer);
    expect(uuidBinSpy).toBeCalledTimes(1);
    expectBuffersToEqual(bufferToArray(uuidBinSpy.mock.results[0].value), challenge.nonce);

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('debug', 'Sending handshake challenge', { reqId: UUID4_REGEX }),
    );
  });

  test('Handshake should fail if response is malformed', async () => {
    const client = new MockPoWebClient(mockWSServer);
    await client.connect();

    await client.send(Buffer.from('invalid handshake response'));

    await expect(client.waitForClose()).resolves.toEqual({
      code: WebSocketCode.CANNOT_ACCEPT,
      reason: 'Invalid handshake response',
    });
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Refusing malformed handshake response', {
        err: expect.objectContaining({ type: InvalidMessageError.name }),
        reqId: UUID4_REGEX,
      }),
    );
  });

  test('Handshake should fail if response is a text frame', async () => {
    const client = new MockPoWebClient(mockWSServer);
    await client.connect();

    await client.send('invalid handshake response');

    await expect(client.waitForClose()).resolves.toEqual({
      code: WebSocketCode.CANNOT_ACCEPT,
      reason: 'Invalid handshake response',
    });
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Refusing malformed handshake response'),
    );
  });

  test('Handshake should fail if response contains zero signatures', async () => {
    const client = new MockPoWebClient(mockWSServer);
    await client.connect();
    await client.receive(); // Discard challenge

    const invalidResponse = new HandshakeResponse([]);
    await client.send(Buffer.from(invalidResponse.serialize()));

    const closeFrame = await client.waitForClose();
    expect(closeFrame).toEqual({
      code: WebSocketCode.CANNOT_ACCEPT,
      reason: 'Handshake response did not include exactly one nonce signature (got 0)',
    });
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Refusing handshake response with invalid number of signatures', {
        nonceSignaturesCount: 0,
        reqId: UUID4_REGEX,
      }),
    );
  });

  test('Handshake should fail if response contains multiple signatures', async () => {
    const client = new MockPoWebClient(mockWSServer);
    await client.connect();
    await client.receive(); // Discard challenge
    const invalidResponse = new HandshakeResponse([
      arrayBufferFrom('signature 1'),
      arrayBufferFrom('signature 2'),
    ]);

    await client.send(Buffer.from(invalidResponse.serialize()));

    const closeFrame = await client.waitForClose();
    expect(closeFrame).toEqual({
      code: WebSocketCode.CANNOT_ACCEPT,
      reason: 'Handshake response did not include exactly one nonce signature (got 2)',
    });
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Refusing handshake response with invalid number of signatures', {
        nonceSignaturesCount: 2,
        reqId: UUID4_REGEX,
      }),
    );
  });

  test('Handshake should fail if response signature is invalid', async () => {
    // Send two signatures: One valid and the other invalid
    const client = new MockPoWebClient(mockWSServer);
    await client.connect();
    await client.receive(); // Discard challenge
    const invalidResponse = new HandshakeResponse([arrayBufferFrom('invalid')]);

    await client.send(Buffer.from(invalidResponse.serialize()));

    const closeFrame = await client.waitForClose();
    expect(closeFrame).toEqual({
      code: WebSocketCode.CANNOT_ACCEPT,
      reason: 'Nonce signature is invalid',
    });
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Refusing handshake response with invalid signature', {
        err: expect.objectContaining({ type: CMSError.name }),
        reqId: UUID4_REGEX,
      }),
    );
  });

  test('Handshake should fail if signer of response nonce is not trusted', async () => {
    MOCK_RETRIEVE_OWN_CERTIFICATES.mockResolvedValue([]);
    const client = new MockPoWebClient(mockWSServer);

    await completeHandshake(client);

    const closeFrame = await client.waitForClose();
    expect(closeFrame).toEqual({
      code: WebSocketCode.CANNOT_ACCEPT,
      reason: 'Nonce signature is invalid',
    });
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Refusing handshake response with invalid signature', {
        err: expect.objectContaining({ type: CMSError.name }),
        reqId: UUID4_REGEX,
      }),
    );
  });

  test('Handshake should complete successfully if all signatures are valid', async () => {
    const client = new MockPoWebClient(mockWSServer);

    await completeHandshake(client);

    await expect(client.waitForClose()).resolves.toEqual({ code: WebSocketCode.NORMAL });
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('debug', 'Handshake completed successfully', {
        peerGatewayAddress,
        reqId: UUID4_REGEX,
      }),
    );
  });

  test('Mongoose connection should be closed by the end of the handshake', async () => {
    const client = new MockPoWebClient(mockWSServer);
    expect(MOCK_MONGOOSE_CONNECTION_CREATION).not.toBeCalled();

    await completeHandshake(client);

    expect(MOCK_MONGOOSE_CONNECTION_CREATION).toBeCalled();
    expect(MOCK_MONGOOSE_CONNECTION.close).toBeCalled();
  });
});

describe('Keep alive', () => {
  test('Connection should be closed upon completion if Keep-Alive is off', async () => {
    const client = new MockPoWebClient(mockWSServer);
    await completeHandshake(client);

    await expect(client.waitForClose()).resolves.toEqual({ code: WebSocketCode.NORMAL });
    expect(client.getLastMessage()).toBeUndefined();
    expect(MOCK_PARCEL_STORE.streamActiveParcelsForGateway).toBeCalledWith(
      peerGatewayAddress,
      partialPinoLogger({ peerGatewayAddress, reqId: expect.anything() }),
    );
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'All parcels were acknowledged shortly after the last one was sent', {
        peerGatewayAddress,
        reqId: UUID4_REGEX,
      }),
    );

    expect(MOCK_PARCEL_STORE.liveStreamActiveParcelsForGateway).not.toBeCalled();
    expect(NatsStreamingClient.initFromEnv).not.toBeCalled();
  });

  test('Connection should be kept alive indefinitely if Keep-Alive is on', async () => {
    const reqId = 'the-request-id';
    const client = new MockPoWebClient(mockWSServer, 'on', undefined, reqId);
    const abortController = new AbortController();

    await completeHandshake(client);

    await sleep(500);
    expect(MOCK_PARCEL_STORE.liveStreamActiveParcelsForGateway).toBeCalledWith(
      peerGatewayAddress,
      MOCK_NATS_STREAMING_CLIENT,
      abortController.signal,
      partialPinoLogger({ peerGatewayAddress, reqId: expect.anything() }),
    );
    expect(NatsStreamingClient.initFromEnv).toBeCalledWith(`parcel-collection-${reqId}`);
    expect(MOCK_PARCEL_STORE.streamActiveParcelsForGateway).not.toBeCalled();

    expect(client.wasConnectionClosed).toBeFalse();
  });

  test('Connection should be kept alive indefinitely if Keep-Alive value is invalid', async () => {
    const client = new MockPoWebClient(mockWSServer, 'THIS IS NOT A VALID VALUE');
    await completeHandshake(client);

    await sleep(500);
    expect(MOCK_PARCEL_STORE.liveStreamActiveParcelsForGateway).toBeCalled();
    expect(MOCK_PARCEL_STORE.streamActiveParcelsForGateway).not.toBeCalled();
  });
});

test('Server should send parcel to client', async () => {
  const client = new MockPoWebClient(mockWSServer);
  getMockInstance(MOCK_PARCEL_STORE.streamActiveParcelsForGateway).mockReturnValue(
    arrayToAsyncIterable([mockParcelStreamMessage(parcelSerialization)]),
  );
  await completeHandshake(client);

  const parcelDeliverySerialized = await client.receive();
  expect(parcelDeliverySerialized).toBeTruthy();
  const parcelDelivery = ParcelDelivery.deserialize(
    bufferToArray(parcelDeliverySerialized as Buffer),
  );
  expect(parcelDelivery).toHaveProperty('deliveryId', UUID4_REGEX);
  expectBuffersToEqual(parcelSerialization, Buffer.from(parcelDelivery.parcelSerialized));

  expect(mockLogging.logs).toContainEqual(
    partialPinoLog('info', 'Sending parcel', { reqId: UUID4_REGEX, peerGatewayAddress }),
  );
});

describe('Acknowledgements', () => {
  test('Server should send parcel to client even if a previous one is unacknowledged', async () => {
    const client = new MockPoWebClient(mockWSServer);
    getMockInstance(MOCK_PARCEL_STORE.streamActiveParcelsForGateway).mockReturnValue(
      arrayToAsyncIterable([
        mockParcelStreamMessage(parcelSerialization),
        mockParcelStreamMessage(parcelSerialization),
      ]),
    );
    await completeHandshake(client);

    const parcelDelivery1Serialized = await client.receive();
    const parcelDelivery1 = ParcelDelivery.deserialize(
      bufferToArray(parcelDelivery1Serialized as Buffer),
    );
    const parcelDelivery2Serialized = await client.receive();
    const parcelDelivery2 = ParcelDelivery.deserialize(
      bufferToArray(parcelDelivery2Serialized as Buffer),
    );
    expect(parcelDelivery1.deliveryId).not.toEqual(parcelDelivery2.deliveryId);
  });

  test('Parcel should be acknowledged in store when client acknowledges it', async () => {
    const parcelStreamMessage = mockParcelStreamMessage(parcelSerialization);
    getMockInstance(MOCK_PARCEL_STORE.streamActiveParcelsForGateway).mockReturnValue(
      arrayToAsyncIterable([parcelStreamMessage]),
    );
    const client = new MockPoWebClient(mockWSServer);
    await completeHandshake(client);

    await receiveAndACKDelivery(client);

    await waitForSetImmediate();
    expect(parcelStreamMessage.ack).toBeCalled();
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Acknowledgement received', {
        parcelObjectKey: parcelStreamMessage.parcelObjectKey,
        peerGatewayAddress,
        reqId: UUID4_REGEX,
      }),
    );
  });

  test('Parcel should not be deleted if client never acknowledges it', async () => {
    const parcelStreamMessage = mockParcelStreamMessage(parcelSerialization);
    getMockInstance(MOCK_PARCEL_STORE.streamActiveParcelsForGateway).mockReturnValue(
      arrayToAsyncIterable([parcelStreamMessage]),
    );
    const client = new MockPoWebClient(mockWSServer);
    await completeHandshake(client);

    // Get the parcel but don't ACK it
    await client.receive();

    await sleep(500);
    expect(parcelStreamMessage.ack).not.toBeCalled();
  });

  test('Connection should be closed with an error if client sends unknown ACK', async () => {
    getMockInstance(MOCK_PARCEL_STORE.streamActiveParcelsForGateway).mockReturnValue(
      arrayToAsyncIterable([mockParcelStreamMessage(parcelSerialization)]),
    );
    const client = new MockPoWebClient(mockWSServer);
    await completeHandshake(client);

    // Get the parcel but acknowledge it with a different id
    await client.receive();
    await client.send('unknown delivery id');

    await expect(client.waitForClose()).resolves.toEqual({
      code: WebSocketCode.CANNOT_ACCEPT,
      reason: 'Unknown delivery id sent as acknowledgement',
    });
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Closing connection due to unknown acknowledgement', {
        peerGatewayAddress,
        reqId: UUID4_REGEX,
      }),
    );
  });

  test('Connection should be closed with an error if client sends a binary ACK', async () => {
    getMockInstance(MOCK_PARCEL_STORE.streamActiveParcelsForGateway).mockReturnValue(
      arrayToAsyncIterable([mockParcelStreamMessage(parcelSerialization)]),
    );
    const client = new MockPoWebClient(mockWSServer);
    await completeHandshake(client);

    // Get the parcel but acknowledge it with a different id
    await client.receive();
    await client.send(Buffer.from('invalid ACK'));

    await expect(client.waitForClose()).resolves.toEqual({
      code: WebSocketCode.CANNOT_ACCEPT,
      reason: 'Unknown delivery id sent as acknowledgement',
    });
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Closing connection due to unknown acknowledgement', {
        peerGatewayAddress,
        reqId: UUID4_REGEX,
      }),
    );
  });

  test('Connection should be closed when all parcels have been delivered and ACKed', async () => {
    // Send two parcels, but not at the same time: Send parcel1 and get an ack1, then send parcel2.
    // The connection shouldn't be closed when ack1 is received just because there's no other parcel
    // in-flight.

    const ackAlert = new EventEmitter();
    getMockInstance(MOCK_PARCEL_STORE.streamActiveParcelsForGateway).mockImplementation(
      async function* (): AsyncIterable<ParcelStreamMessage> {
        // parcel1
        yield mockParcelStreamMessage(parcelSerialization, () => ackAlert.emit('ackProcessed'));

        await Promise.all([
          waitForEvent('ackSent', ackAlert),
          waitForEvent('ackProcessed', ackAlert),
        ]);

        // parcel2
        yield mockParcelStreamMessage(parcelSerialization);
      },
    );
    const client = new MockPoWebClient(mockWSServer);
    await completeHandshake(client);

    await receiveAndACKDelivery(client); // parcel1
    ackAlert.emit('ackSent');

    const parcel2DeliverySerialized = (await client.receive()) as Buffer;
    expect(client.wasConnectionClosed).toBeFalse();
    const parcel2Delivery = ParcelDelivery.deserialize(bufferToArray(parcel2DeliverySerialized));
    await client.send(parcel2Delivery.deliveryId);
    await expect(client.waitForClose()).resolves.toEqual({ code: WebSocketCode.NORMAL });

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Closing connection after all parcels have been acknowledged', {
        peerGatewayAddress,
        reqId: UUID4_REGEX,
      }),
    );
  });

  async function receiveAndACKDelivery(client: MockPoWebClient): Promise<void> {
    const parcelDeliverySerialized = (await client.receive()) as Buffer;
    const parcelDelivery = ParcelDelivery.deserialize(bufferToArray(parcelDeliverySerialized));
    await client.send(parcelDelivery.deliveryId);
  }
});

test('Client-initiated WebSocket connection closure should be handled gracefully', async () => {
  const abortSpy = jest.spyOn(AbortController.prototype, 'abort');
  const client = new MockPoWebClient(mockWSServer, 'on');
  await client.connect();

  expect(abortSpy).not.toBeCalled();
  const closeReason = 'I have to go';
  client.disconnect(WebSocketCode.NORMAL, closeReason);

  expect(abortSpy).toBeCalled();
  expect(mockLogging.logs).toContainEqual(
    partialPinoLog('info', 'Closing connection', {
      closeCode: WebSocketCode.NORMAL,
      closeReason,
      reqId: UUID4_REGEX,
    }),
  );
});

test('Abrupt TCP connection closure should be handled gracefully', async () => {
  const abortSpy = jest.spyOn(AbortController.prototype, 'abort');
  const client = new MockPoWebClient(mockWSServer, 'on');
  await client.connect();

  expect(abortSpy).not.toBeCalled();
  const error = new Error('Sorry, I have to go');
  client.abort(error);

  expect(abortSpy).toBeCalled();
  expect(mockLogging.logs).toContainEqual(
    partialPinoLog('info', 'Closing connection due to error', {
      err: expect.objectContaining({ message: error.message }),
      reqId: UUID4_REGEX,
    }),
  );
});

function mockParcelStreamMessage(
  parcelSerialized: Buffer,
  ackCallback: () => void = () => undefined,
): ParcelStreamMessage {
  return {
    ack: jest.fn().mockImplementation(ackCallback),
    parcelObjectKey: 'prefix/id.parcel',
    parcelSerialized,
  };
}

async function completeHandshake(client: MockPoWebClient): Promise<void> {
  await client.connect();

  const challenge = HandshakeChallenge.deserialize((await client.receive()) as ArrayBuffer);
  const response = new HandshakeResponse([
    await nonceSigner.sign(challenge.nonce, DETACHED_SIGNATURE_TYPES.NONCE),
  ]);

  await client.send(Buffer.from(response.serialize()));
}

async function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForSetImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForEvent<T>(eventName: string, eventEmitter: EventEmitter): Promise<T> {
  return new Promise((resolve) => eventEmitter.once(eventName, resolve));
}

class MockPoWebClient extends MockWebSocketClient {
  constructor(wsServer: WSServer, keepAlive: string = 'off', origin?: string, requestId?: string) {
    super(wsServer, {
      'x-relaynet-keep-alive': keepAlive,
      ...(requestId && { [REQUEST_ID_HEADER]: requestId }),
      ...(origin && { origin }),
    });
  }
}
