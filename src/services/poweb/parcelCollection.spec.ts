import { HandshakeChallenge, HandshakeResponse } from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { EventEmitter } from 'events';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import uuid from 'uuid-random';
import WebSocket, { Data as WSData, Server as WSServer } from 'ws';

import { expectBuffersToEqual } from '../_test_utils';
import parcelCollection from './parcelCollection';
import { WebSocketCode } from './websockets';

test('Requests with Origin header should be refused', () => {
  const client = new MockWebSocketClient(parcelCollection(), 'https://invalid.local');

  client.connect();

  expect(client.serverCloseFrame).toEqual({
    code: WebSocketCode.VIOLATED_POLICY,
    reason: 'Web browser requests are disabled for security reasons',
  });
});

describe('Handshake', () => {
  test('Challenge should be sent as soon as client connects', () => {
    const uuidBinSpy = jest.spyOn(uuid, 'bin');
    const client = new MockWebSocketClient(parcelCollection());
    client.connect();

    const challengeSerialized = client.receive();
    expect(challengeSerialized).toBeInstanceOf(ArrayBuffer);
    const challenge = HandshakeChallenge.deserialize(challengeSerialized as ArrayBuffer);
    expect(uuidBinSpy).toBeCalledTimes(1);
    expectBuffersToEqual(bufferToArray(uuidBinSpy.mock.results[0].value), challenge.nonce);
  });

  test('Connection should error out if handshake response is invalid', () => {
    const client = new MockWebSocketClient(parcelCollection());
    client.connect();
    client.receive(); // Discard challenge

    client.send('invalid handshake response');

    expect(client.serverCloseFrame).toEqual({
      code: WebSocketCode.CANNOT_ACCEPT,
      reason: 'Invalid handshake response',
    });
  });

  test('Connection should error out if handshake response contains zero signatures', () => {
    const client = new MockWebSocketClient(parcelCollection());
    client.connect();
    client.receive(); // Discard challenge

    const invalidResponse = new HandshakeResponse([]);
    client.send(invalidResponse.serialize());

    expect(client.serverCloseFrame).toEqual({
      code: WebSocketCode.CANNOT_ACCEPT,
      reason: 'Invalid handshake response',
    });
    // TODO: Check logs
  });

  test.todo(
    'Connection should error out if handshake response contains at least one invalid signature',
  );

  test.todo(
    'Connection should error out if handshake response contains at least one invalid certificate',
  );

  test.todo('Handshake should complete successfully if all signatures are valid');
});

test.todo('Server should close if there is not Keep-Alive and no parcel to receive');

test.todo('Server should keep connection if Keep-Alive is on');

test.todo('Server should keep connection if Keep-Alive is invalid value');

test.todo('Server should send parcel to deliver');

test.todo('Server should process client parcel acks');

test.todo('Server should tell the client that it cannot accept binary acks');

test.todo('Server should handle gracefully client closes with normal');

test.todo('Server should handle gracefully client closes with another reason besides normal');

// class MockWebSocketMessageSet extends Duplex {
//   // tslint:disable-next-line:readonly-array
//   private readonly incomingMessages: WSData[] = [];
//
//   constructor(private wsConnection: WebSocket) {
//     super({ objectMode: true });
//
//     wsConnection.on('message', (message) => {
//       this.incomingMessages.push(message);
//
//       if (this.isPaused()) {
//         this.resume();
//       }
//     });
//   }
//
//   public _read(_size: number): void {
//     this.push(this.incomingMessages.pop() ?? null);
//
//     if (this.incomingMessages.length === 0) {
//       this.pause();
//     }
//   }
//
//   public _write(chunk: WSData, _encoding: string, callback: (error?: Error | null) => void): void {
//     this.wsConnection.emit('message', chunk);
//     callback();
//   }
// }

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

  constructor() {
    super('ws://test.local', null as any);
  }

  public send(data: any, _cb?: any): void {
    this.incomingMessages.push(data);
  }

  public close(code?: number, reason?: string): void {
    // tslint:disable-next-line:no-object-mutation
    this.serverCloseFrame = { code, reason };
  }
}

// tslint:disable-next-line:max-classes-per-file
class MockWebSocketClient extends EventEmitter {
  // tslint:disable-next-line:readonly-keyword
  public get serverCloseFrame(): WebSocketCloseMessage | null {
    return this.wsConnection.serverCloseFrame;
  }

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

  public connect(): void {
    const incomingMessage = new IncomingMessage(this.socket);
    // tslint:disable-next-line:no-object-mutation
    incomingMessage.headers.origin = this.origin;
    this.wsServer.emit('connection', this.wsConnection, incomingMessage);
  }

  public send(message: WSData): void {
    this.wsConnection.emit('message', message);
  }

  public receive(): WSData | undefined {
    return this.wsConnection.incomingMessages.pop();
  }
}
