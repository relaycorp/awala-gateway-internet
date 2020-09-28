// tslint:disable:no-let
import {
  CMSError,
  HandshakeChallenge,
  HandshakeResponse,
  InvalidMessageError,
  NonceSigner,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { EventEmitter } from 'events';
import { IncomingMessage } from 'http';
import { Connection } from 'mongoose';
import { Socket } from 'net';
import uuid from 'uuid-random';
import WebSocket, { Data as WSData, Server as WSServer } from 'ws';

import {
  arrayBufferFrom,
  makeMockLogging,
  MockLogSet,
  mockSpy,
  partialPinoLog,
  PdaChain,
} from '../../_test_utils';
import * as mongo from '../../backingServices/mongo';
import { expectBuffersToEqual, generatePdaChain } from '../_test_utils';
import * as certs from '../certs';
import parcelCollection from './parcelCollection';
import { WebSocketCode } from './websockets';

let LOGS: MockLogSet;
let MOCK_WS_SERVER: WSServer;
beforeEach(() => {
  const mockLogging = makeMockLogging();
  MOCK_WS_SERVER = parcelCollection(mockLogging.logger);
  LOGS = mockLogging.logs;
});

let PDA_CHAIN: PdaChain;
let NONCE_SIGNER: NonceSigner;
beforeAll(async () => {
  PDA_CHAIN = await generatePdaChain();
  NONCE_SIGNER = new NonceSigner(PDA_CHAIN.privateGatewayCert, PDA_CHAIN.privateGatewayPrivateKey);
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
    return [PDA_CHAIN.publicGatewayCert];
  },
);

describe('Logging', () => {
  test.todo('Logs should include request id from headers if present');

  test.todo('Logs should include autogenerated request id if missing from headers');
});

test('Requests with Origin header should be refused', async () => {
  const client = new MockWebSocketClient(MOCK_WS_SERVER, 'https://invalid.local');

  await client.connect();

  const closeFrame = await client.waitForClose();
  expect(closeFrame).toEqual({
    code: WebSocketCode.VIOLATED_POLICY,
    reason: 'Web browser requests are disabled for security reasons',
  });
  expect(LOGS).toContainEqual(partialPinoLog('debug', 'Denying web browser request'));
});

describe('Mongoose connection', () => {
  test('Connection should be opened when request starts', async () => {
    const client = new MockWebSocketClient(MOCK_WS_SERVER);

    expect(MOCK_MONGOOSE_CONNECTION_CREATION).not.toBeCalled();
    await client.connect();
    expect(MOCK_MONGOOSE_CONNECTION_CREATION).toBeCalled();
  });

  test('Connection should be closed when request ends', async () => {
    const client = new MockWebSocketClient(MOCK_WS_SERVER);

    await client.connect();
    client.disconnect();

    expect(MOCK_MONGOOSE_CONNECTION.close).toBeCalled();
  });
});

describe('Handshake', () => {
  test('Challenge should be sent as soon as client connects', async () => {
    const uuidBinSpy = jest.spyOn(uuid, 'bin');
    const client = new MockWebSocketClient(MOCK_WS_SERVER);
    await client.connect();

    const challengeSerialized = client.receive();
    expect(challengeSerialized).toBeInstanceOf(ArrayBuffer);
    const challenge = HandshakeChallenge.deserialize(challengeSerialized as ArrayBuffer);
    expect(uuidBinSpy).toBeCalledTimes(1);
    expectBuffersToEqual(bufferToArray(uuidBinSpy.mock.results[0].value), challenge.nonce);

    expect(LOGS).toContainEqual(partialPinoLog('debug', 'Sending handshake challenge'));
  });

  test('Handshake should fail if response is invalid', async () => {
    const client = new MockWebSocketClient(MOCK_WS_SERVER);
    await client.connect();
    client.receive(); // Discard challenge

    await client.send(arrayBufferFrom('invalid handshake response'));

    const closeFrame = await client.waitForClose();
    expect(closeFrame).toEqual({
      code: WebSocketCode.CANNOT_ACCEPT,
      reason: 'Invalid handshake response',
    });
    expect(LOGS).toContainEqual(
      partialPinoLog('info', 'Refusing malformed handshake response', {
        err: expect.objectContaining({ type: InvalidMessageError.name }),
      }),
    );
  });

  test('Handshake should fail if response contains zero signatures', async () => {
    const client = new MockWebSocketClient(MOCK_WS_SERVER);
    await client.connect();
    client.receive(); // Discard challenge

    const invalidResponse = new HandshakeResponse([]);
    await client.send(invalidResponse.serialize());

    const closeFrame = await client.waitForClose();
    expect(closeFrame).toEqual({
      code: WebSocketCode.CANNOT_ACCEPT,
      reason: 'Handshake response did not include any nonce signatures',
    });
    expect(LOGS).toContainEqual(
      partialPinoLog('info', 'Refusing handshake response with no signatures'),
    );
  });

  test('Handshake should fail if response contains invalid signature', async () => {
    // Send two signatures: One valid and the other invalid
    const client = new MockWebSocketClient(MOCK_WS_SERVER);
    await client.connect();
    const challenge = HandshakeChallenge.deserialize(client.receive() as ArrayBuffer);
    const validSignature = await NONCE_SIGNER.sign(challenge.nonce);
    const invalidResponse = new HandshakeResponse([validSignature, arrayBufferFrom('invalid')]);

    await client.send(invalidResponse.serialize());

    const closeFrame = await client.waitForClose();
    expect(closeFrame).toEqual({
      code: WebSocketCode.CANNOT_ACCEPT,
      reason: 'Handshake response included invalid nonce signatures',
    });
    expect(LOGS).toContainEqual(
      partialPinoLog('info', 'Refusing handshake response with invalid signature', {
        err: expect.objectContaining({ type: CMSError.name }),
      }),
    );
  });

  test('Handshake should fail if response contains at least one invalid certificate', async () => {
    const client = new MockWebSocketClient(MOCK_WS_SERVER);
    await client.connect();
    const challenge = HandshakeChallenge.deserialize(client.receive() as ArrayBuffer);
    const validSignature = await NONCE_SIGNER.sign(challenge.nonce);
    const invalidResponse = new HandshakeResponse([validSignature]);
    MOCK_RETRIEVE_OWN_CERTIFICATES.mockResolvedValue([]);

    await client.send(invalidResponse.serialize());

    const closeFrame = await client.waitForClose();
    expect(closeFrame).toEqual({
      code: WebSocketCode.CANNOT_ACCEPT,
      reason: 'Handshake response included invalid nonce signatures',
    });
    expect(LOGS).toContainEqual(
      partialPinoLog('info', 'Refusing handshake response with invalid signature', {
        err: expect.objectContaining({ type: CMSError.name }),
      }),
    );
  });

  test('Handshake should complete successfully if all signatures are valid', async () => {
    const client = new MockWebSocketClient(MOCK_WS_SERVER);
    await client.connect();
    const challenge = HandshakeChallenge.deserialize(client.receive() as ArrayBuffer);
    const response = new HandshakeResponse([await NONCE_SIGNER.sign(challenge.nonce)]);

    await client.send(response.serialize());

    await expect(client.waitForClose()).resolves.toEqual({ code: WebSocketCode.NORMAL });
  });
});

test.todo('Server should close if there is not Keep-Alive and no parcel to receive');

test.todo('Server should keep connection if Keep-Alive is on');

test.todo('Server should keep connection if Keep-Alive is invalid value');

test.todo('Server should send parcel to deliver');

test.todo('Server should process client parcel acks');

test.todo('Server should tell the client that it cannot accept binary acks');

test.todo('Server should handle gracefully client closes with normal');

test.todo('Server should handle gracefully client closes with another reason besides normal');

interface WebSocketCloseMessage {
  readonly code?: number;
  readonly reason?: string;
}

// tslint:disable-next-line:max-classes-per-file
class MockWebSocketConnection extends WebSocket {
  // tslint:disable-next-line:readonly-keyword
  public serverCloseFrame: WebSocketCloseMessage | null = null;
  // tslint:disable-next-line:readonly-array
  public readonly incomingMessages: WSData[] = [];
  public readonly serverEvents = new EventEmitter();

  constructor() {
    super('ws://test.local', null as any);
  }

  public send(data: any, _cb?: any): void {
    this.incomingMessages.push(data);
  }

  public close(code?: number, reason?: string): void {
    // tslint:disable-next-line:no-object-mutation
    this.serverCloseFrame = { code, reason };
    this.serverEvents.emit('close', this.serverCloseFrame);
  }
}

// tslint:disable-next-line:max-classes-per-file
class MockWebSocketClient extends EventEmitter {
  private readonly wsConnection: MockWebSocketConnection;
  private readonly socket: Socket;

  constructor(private wsServer: WSServer, private origin?: string) {
    super();

    this.socket = new Socket();
    this.socket.on('error', (hadError) => {
      // tslint:disable-next-line:no-console
      console.log({ hadError });
    });

    this.wsConnection = new MockWebSocketConnection();
  }

  public async connect(): Promise<void> {
    const incomingMessage = new IncomingMessage(this.socket);
    // tslint:disable-next-line:no-object-mutation
    incomingMessage.headers.origin = this.origin;
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

  public receive(): ArrayBuffer | undefined {
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
