// tslint:disable:no-let

import {
  CMSError,
  HandshakeChallenge,
  HandshakeResponse,
  InvalidMessageError,
  NonceSigner,
  ParcelDelivery,
} from '@relaycorp/relaynet-core';
import AbortController from 'abort-controller';
import bufferToArray from 'buffer-to-arraybuffer';
import { EventEmitter } from 'events';
import { IncomingMessage } from 'http';
import { Connection } from 'mongoose';
import { Socket } from 'net';
import { Duplex } from 'stream';
import uuid from 'uuid-random';
import WS, { Data as WSData, Server as WSServer } from 'ws';

import {
  arrayBufferFrom,
  arrayToAsyncIterable,
  makeMockLogging,
  MockLogging,
  mockSpy,
  partialPinoLog,
  partialPinoLogger,
  PdaChain,
  UUID4_REGEX,
} from '../../_test_utils';
import * as mongo from '../../backingServices/mongo';
import { NatsStreamingClient } from '../../backingServices/natsStreaming';
import { expectBuffersToEqual, generatePdaChain } from '../_test_utils';
import * as certs from '../certs';
import { ParcelStore, ParcelStreamMessage } from '../parcelStore';
import parcelCollection from './parcelCollection';
import { WebSocketCode } from './websockets';

const REQUEST_ID_HEADER = 'X-Request';

let mockWSServer: WSServer;
let mockLogging: MockLogging;
beforeEach(() => {
  mockLogging = makeMockLogging();
  mockWSServer = parcelCollection(REQUEST_ID_HEADER, mockLogging.logger);
});

let pdaChain: PdaChain;
let nonceSigner: NonceSigner;
let peerGatewayAddress: string;
beforeAll(async () => {
  pdaChain = await generatePdaChain();
  nonceSigner = new NonceSigner(pdaChain.privateGatewayCert, pdaChain.privateGatewayPrivateKey);
  peerGatewayAddress = await pdaChain.privateGatewayCert.calculateSubjectPrivateAddress();
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
    return [pdaChain.publicGatewayCert];
  },
);

const MOCK_PARCEL_STORE = new ParcelStore(null as any, null as any);
jest.spyOn(ParcelStore, 'initFromEnv').mockReturnValue(MOCK_PARCEL_STORE);
const MOCK_PARCEL_LIVE_STREAM = mockSpy(
  jest.spyOn(ParcelStore.prototype, 'liveStreamActiveParcelsForGateway'),
  async function* (): AsyncIterable<any> {
    // tslint:disable-next-line:no-unused-expression
    await new Promise(() => 'A promise that never resolves');
  },
);
const MOCK_PARCEL_NON_LIVE_STREAM = mockSpy(
  jest.spyOn(ParcelStore.prototype, 'streamActiveParcelsForGateway'),
  () => arrayToAsyncIterable([]),
);

const MOCK_NATS_STREAMING_CLIENT = new NatsStreamingClient(null as any, null as any, null as any);
jest.spyOn(NatsStreamingClient, 'initFromEnv').mockReturnValue(MOCK_NATS_STREAMING_CLIENT);

const parcelSerialization = Buffer.from('This is supposed to be a RAMF serialization');

mockSpy(jest.spyOn(WS, 'createWebSocketStream'), (ws: MockWebSocketConnection) => ws.makeDuplex());

describe('Request id', () => {
  test('Existing request id should be honored if present in request headers', async () => {
    const reqId = '123-id';
    const client = new MockWebSocketClient(mockWSServer, 'off', 'origin', reqId);

    await client.connect();
    await client.waitForClose();

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('debug', 'Starting parcel collection request', { reqId }),
    );
  });

  test('Request id should be generated if not present in request headers', async () => {
    const client = new MockWebSocketClient(mockWSServer, 'off', 'origin');

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
  const client = new MockWebSocketClient(mockWSServer, 'on', 'https://invalid.local');

  await client.connect();

  const closeFrame = await client.waitForClose();
  expect(closeFrame).toEqual({
    code: WebSocketCode.VIOLATED_POLICY,
    reason: 'Web browser requests are disabled for security reasons',
  });
  expect(mockLogging.logs).toContainEqual(
    partialPinoLog('debug', 'Denying web browser request', { reqId: expect.anything() }),
  );
});

describe('Mongoose connection', () => {
  test('Connection should be opened when request starts', async () => {
    const client = new MockWebSocketClient(mockWSServer);

    expect(MOCK_MONGOOSE_CONNECTION_CREATION).not.toBeCalled();
    await client.connect();
    expect(MOCK_MONGOOSE_CONNECTION_CREATION).toBeCalled();
  });

  test('Connection should be closed when request ends', async () => {
    const client = new MockWebSocketClient(mockWSServer);

    await client.connect();
    client.disconnect();

    expect(MOCK_MONGOOSE_CONNECTION.close).toBeCalled();
  });
});

describe('Handshake', () => {
  test('Challenge should be sent as soon as client connects', async () => {
    const uuidBinSpy = jest.spyOn(uuid, 'bin');
    const client = new MockWebSocketClient(mockWSServer);
    await client.connect();

    const challengeSerialized = client.getLastMessage();
    expect(challengeSerialized).toBeInstanceOf(ArrayBuffer);
    const challenge = HandshakeChallenge.deserialize(challengeSerialized as ArrayBuffer);
    expect(uuidBinSpy).toBeCalledTimes(1);
    expectBuffersToEqual(bufferToArray(uuidBinSpy.mock.results[0].value), challenge.nonce);

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('debug', 'Sending handshake challenge', { reqId: expect.anything() }),
    );
  });

  test.todo('Handshake should fail if response is a text frame');

  test('Handshake should fail if response is invalid', async () => {
    const client = new MockWebSocketClient(mockWSServer);
    await client.connect();
    client.getLastMessage(); // Discard challenge

    await client.send(arrayBufferFrom('invalid handshake response'));

    const closeFrame = await client.waitForClose();
    expect(closeFrame).toEqual({
      code: WebSocketCode.CANNOT_ACCEPT,
      reason: 'Invalid handshake response',
    });
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Refusing malformed handshake response', {
        err: expect.objectContaining({ type: InvalidMessageError.name }),
        reqId: expect.anything(),
      }),
    );
  });

  test('Handshake should fail if response contains zero signatures', async () => {
    const client = new MockWebSocketClient(mockWSServer);
    await client.connect();
    client.getLastMessage(); // Discard challenge

    const invalidResponse = new HandshakeResponse([]);
    await client.send(invalidResponse.serialize());

    const closeFrame = await client.waitForClose();
    expect(closeFrame).toEqual({
      code: WebSocketCode.CANNOT_ACCEPT,
      reason: 'Handshake response did not include exactly one nonce signature (got 0)',
    });
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Refusing handshake response with invalid number of signatures', {
        nonceSignaturesCount: 0,
        reqId: expect.anything(),
      }),
    );
  });

  test('Handshake should fail if response contains multiple signatures', async () => {
    const client = new MockWebSocketClient(mockWSServer);
    await client.connect();
    client.getLastMessage(); // Discard challenge
    const response = new HandshakeResponse([
      arrayBufferFrom('signature 1'),
      arrayBufferFrom('signature 2'),
    ]);

    await client.send(response.serialize());

    const invalidResponse = new HandshakeResponse([]);
    await client.send(invalidResponse.serialize());

    const closeFrame = await client.waitForClose();
    expect(closeFrame).toEqual({
      code: WebSocketCode.CANNOT_ACCEPT,
      reason: 'Handshake response did not include exactly one nonce signature (got 2)',
    });
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Refusing handshake response with invalid number of signatures', {
        nonceSignaturesCount: 2,
        reqId: expect.anything(),
      }),
    );
  });

  test('Handshake should fail if response signature is invalid', async () => {
    // Send two signatures: One valid and the other invalid
    const client = new MockWebSocketClient(mockWSServer);
    await client.connect();
    client.getLastMessage(); // Discard challenge
    const invalidResponse = new HandshakeResponse([arrayBufferFrom('invalid')]);

    await client.send(invalidResponse.serialize());

    const closeFrame = await client.waitForClose();
    expect(closeFrame).toEqual({
      code: WebSocketCode.CANNOT_ACCEPT,
      reason: 'Nonce signature is invalid',
    });
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Refusing handshake response with invalid signature', {
        err: expect.objectContaining({ type: CMSError.name }),
        reqId: expect.anything(),
      }),
    );
  });

  test('Handshake should fail if signer of response nonce is not trusted', async () => {
    MOCK_RETRIEVE_OWN_CERTIFICATES.mockResolvedValue([]);
    const client = new MockWebSocketClient(mockWSServer);

    await completeHandshake(client);

    const closeFrame = await client.waitForClose();
    expect(closeFrame).toEqual({
      code: WebSocketCode.CANNOT_ACCEPT,
      reason: 'Nonce signature is invalid',
    });
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Refusing handshake response with invalid signature', {
        err: expect.objectContaining({ type: CMSError.name }),
        reqId: expect.anything(),
      }),
    );
  });

  test('Handshake should complete successfully if all signatures are valid', async () => {
    const client = new MockWebSocketClient(mockWSServer, 'off');

    await completeHandshake(client);

    await expect(client.waitForClose()).resolves.toEqual({ code: WebSocketCode.NORMAL });
  });
});

describe('Keep alive', () => {
  test('Connection should be closed upon completion if Keep-Alive is off', async () => {
    const client = new MockWebSocketClient(mockWSServer, 'off');
    await completeHandshake(client);

    await expect(client.waitForClose()).resolves.toEqual({ code: WebSocketCode.NORMAL });
    expect(client.getLastMessage()).toBeUndefined();
    expect(MOCK_PARCEL_NON_LIVE_STREAM).toBeCalledWith(
      peerGatewayAddress,
      partialPinoLogger({ peerGatewayAddress, reqId: expect.anything() }),
    );

    expect(MOCK_PARCEL_LIVE_STREAM).not.toBeCalled();
    expect(NatsStreamingClient.initFromEnv).not.toBeCalled();
  });

  test('Connection should be kept alive indefinitely if Keep-Alive is on', async (cb) => {
    const reqId = 'the-request-id';
    const client = new MockWebSocketClient(mockWSServer, 'on', undefined, reqId);
    const abortController = new AbortController();
    await completeHandshake(client);

    setTimeout(async () => {
      expect(MOCK_PARCEL_LIVE_STREAM).toBeCalledWith(
        peerGatewayAddress,
        MOCK_NATS_STREAMING_CLIENT,
        abortController.signal,
        partialPinoLogger({ peerGatewayAddress, reqId: expect.anything() }),
      );
      expect(NatsStreamingClient.initFromEnv).toBeCalledWith(`parcel-collection-${reqId}`);
      expect(MOCK_PARCEL_NON_LIVE_STREAM).not.toBeCalled();

      expect(client.wasConnectionClosed).toBeFalse();
      client.disconnect();

      cb();
    }, 500);
  });

  test('Connection should be kept alive indefinitely if Keep-Alive value is invalid', async (cb) => {
    const client = new MockWebSocketClient(mockWSServer, 'THIS IS NOT A VALID VALUE');
    await completeHandshake(client);

    setTimeout(async () => {
      expect(MOCK_PARCEL_LIVE_STREAM).toBeCalled();
      expect(MOCK_PARCEL_NON_LIVE_STREAM).not.toBeCalled();
      client.disconnect();

      cb();
    }, 100);
  });
});

test('Server should send parcel to client', async () => {
  const client = new MockWebSocketClient(mockWSServer, 'off');
  MOCK_PARCEL_NON_LIVE_STREAM.mockReturnValue(
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
});

describe('Acknowledgements', () => {
  test.todo('Parcel should be deleted when client acknowledges its receipt');

  test.todo('Connection should be closed with an error if client sends unknown ACK');

  test.todo('Connection should be closed with an error if client sends a binary ACK');
});

test.todo('Connection should be closed gracefully if client closes it with a normal reason');

test.todo('Server should handle gracefully client closes with another reason besides normal');

function mockParcelStreamMessage(parcelSerialized: Buffer): ParcelStreamMessage {
  return { ack: jest.fn(), parcelSerialized };
}

async function completeHandshake(client: MockWebSocketClient): Promise<void> {
  await client.connect();

  const challenge = HandshakeChallenge.deserialize(client.getLastMessage() as ArrayBuffer);
  const response = new HandshakeResponse([await nonceSigner.sign(challenge.nonce)]);

  await client.send(response.serialize());
}

//region WebSocket utilities

interface WebSocketCloseMessage {
  readonly code?: number;
  readonly reason?: string;
}

// tslint:disable-next-line:max-classes-per-file
class MockWebSocketConnection extends EventEmitter {
  // tslint:disable-next-line:readonly-keyword
  public serverCloseFrame: WebSocketCloseMessage | null = null;
  // tslint:disable-next-line:readonly-array
  public readonly incomingMessages: WSData[] = [];
  public readonly serverEvents = new EventEmitter();

  public send(data: any): void {
    this.incomingMessages.push(data);
    this.serverEvents.emit('messageSent', data);
  }

  public close(code?: number, reason?: string): void {
    // tslint:disable-next-line:no-object-mutation
    this.serverCloseFrame = { code, reason };
    this.serverEvents.emit('close', this.serverCloseFrame);
  }

  public makeDuplex(): Duplex {
    // tslint:disable-next-line:no-this-assignment
    const connection = this;
    const duplex = new Duplex({
      objectMode: true,
      write(chunk: any, _encoding: string, callback: (error?: Error | null) => void): void {
        connection.send(chunk);
        callback();
      },
    });

    this.on('message', (message) => {
      if (!duplex.push(message)) {
        duplex.pause();
      }
    });

    this.on('close', () => duplex.push(null));

    this.on('error', (error) => duplex.destroy(error));

    return duplex;
  }
}

// tslint:disable-next-line:max-classes-per-file
class MockWebSocketClient extends EventEmitter {
  private readonly wsConnection: MockWebSocketConnection;
  private readonly socket: Socket;

  constructor(
    private wsServer: WSServer,
    private keepAlive: string = 'on',
    private origin?: string,
    private requestId?: string,
  ) {
    super();

    this.socket = new Socket();
    this.socket.on('error', (hadError) => {
      // tslint:disable-next-line:no-console
      console.log({ hadError });
    });

    this.wsConnection = new MockWebSocketConnection();
  }

  get wasConnectionClosed(): boolean {
    return this.wsConnection.serverCloseFrame !== null;
  }

  public async connect(): Promise<void> {
    const incomingMessage = new IncomingMessage(this.socket);
    // tslint:disable-next-line:no-object-mutation
    incomingMessage.headers = {
      ...incomingMessage.headers,
      origin: this.origin,
      'x-relaynet-keep-alive': this.keepAlive,
      [REQUEST_ID_HEADER]: this.requestId,
    };
    return new Promise((resolve) => {
      this.wsServer.once('connection', resolve);
      this.wsServer.emit('connection', this.wsConnection, incomingMessage);
    });
  }

  public disconnect(code?: number, reason?: string): void {
    this.wsConnection.emit('close', code, reason);
  }

  public async send(message: ArrayBuffer): Promise<void> {
    return new Promise((resolve) => {
      this.wsConnection.once('message', resolve);
      this.wsConnection.emit('message', message);
    });
  }

  public async receive(): Promise<WSData> {
    return new Promise((resolve) => {
      this.wsConnection.serverEvents.once('messageSent', resolve);
    });
  }

  public getLastMessage(): ArrayBuffer | undefined {
    return this.wsConnection.incomingMessages.pop() as ArrayBuffer | undefined;
  }

  public async waitForClose(): Promise<WebSocketCloseMessage> {
    return new Promise((resolve) => {
      if (this.wsConnection.serverCloseFrame) {
        resolve(this.wsConnection.serverCloseFrame);
        return;
      }
      this.wsConnection.serverEvents.once('close', resolve);
    });
  }
}

//endregion
