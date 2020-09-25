/* tslint:disable:no-console */
import { HandshakeChallenge } from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { Server as HTTPServer } from 'http';
import uuid from 'uuid-random';
import { Server as WSServer } from 'ws';

import { WebSocketCode } from './websockets';

export default function (httpServer?: HTTPServer): WSServer {
  const wsServer = new WSServer({
    server: httpServer,
    ...(httpServer === undefined && { noServer: true }),
  });

  wsServer.on('connection', (wsConnection, request) => {
    if (request.headers.origin) {
      wsConnection.close(
        WebSocketCode.VIOLATED_POLICY,
        'Web browser requests are disabled for security reasons',
      );
      return;
    }

    wsConnection.on('message', (_message) => {
      wsConnection.close(WebSocketCode.CANNOT_ACCEPT, 'Invalid handshake response');
    });

    const challenge = new HandshakeChallenge(bufferToArray(uuid.bin() as Buffer));
    wsConnection.send(challenge.serialize());
  });

  return wsServer;
}
