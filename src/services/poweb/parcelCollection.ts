import { HandshakeChallenge, HandshakeResponse, NONCE_SIGNATURE } from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { FastifyLoggerInstance } from 'fastify';
import uuid from 'uuid-random';
import { Server as WSServer } from 'ws';

import { createMongooseConnectionFromEnv } from '../../backingServices/mongo';
import { retrieveOwnCertificates } from '../certs';
import { WebSocketCode } from './websockets';

export default function (logger: FastifyLoggerInstance): WSServer {
  const wsServer = new WSServer({
    noServer: true,
  });

  wsServer.on('connection', async (wsConnection, request) => {
    if (request.headers.origin) {
      logger.debug('Denying web browser request');
      wsConnection.close(
        WebSocketCode.VIOLATED_POLICY,
        'Web browser requests are disabled for security reasons',
      );
      return;
    }

    const nonce = bufferToArray(uuid.bin() as Buffer);

    const mongooseConnection = await createMongooseConnectionFromEnv();
    wsConnection.on('close', () => mongooseConnection.close());

    wsConnection.once('message', async (message: ArrayBuffer) => {
      // tslint:disable-next-line:no-let
      let handshakeResponse: HandshakeResponse;
      try {
        handshakeResponse = HandshakeResponse.deserialize(message);
      } catch (err) {
        logger.info({ err }, 'Refusing malformed handshake response');
        wsConnection.close(WebSocketCode.CANNOT_ACCEPT, 'Invalid handshake response');
        return;
      }

      if (handshakeResponse.nonceSignatures.length === 0) {
        logger.info('Refusing handshake response with no signatures');
        wsConnection.close(
          WebSocketCode.CANNOT_ACCEPT,
          'Handshake response did not include any nonce signatures',
        );
        return;
      }

      const trustedCertificates = await retrieveOwnCertificates(mongooseConnection);
      const nonceSignatureVerifications = handshakeResponse.nonceSignatures.map((s) =>
        NONCE_SIGNATURE.verify(s, nonce, trustedCertificates),
      );
      try {
        await Promise.all(nonceSignatureVerifications);
      } catch (err) {
        logger.info({ err }, 'Refusing handshake response with invalid signature');
        wsConnection.close(
          WebSocketCode.CANNOT_ACCEPT,
          'Handshake response included invalid nonce signatures',
        );
        return;
      }

      wsConnection.close(WebSocketCode.NORMAL);
    });

    logger.debug('Sending handshake challenge');
    const challenge = new HandshakeChallenge(nonce);
    wsConnection.send(challenge.serialize());
  });

  return wsServer;
}
