import { PrivateNodeRegistrationAuthorization } from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { FastifyInstance, FastifyReply } from 'fastify';

import { PNRA_CONTENT_TYPE } from './contentTypes';
import RouteOptions from './RouteOptions';

const ENDPOINT_URL = '/v1/pre-registrations';

export default async function registerRoutes(
  fastify: FastifyInstance,
  options: RouteOptions,
): Promise<void> {
  const unboundKeyPair = await options.privateKeyStore.fetchNodeKey(options.gatewayKeyId);
  const ownPrivateKey = unboundKeyPair.privateKey;

  fastify.route({
    method: ['HEAD', 'GET', 'PUT', 'DELETE', 'PATCH'],
    url: ENDPOINT_URL,
    async handler(_req, reply): Promise<void> {
      reply.code(405).header('Allow', 'POST').send();
    },
  });

  fastify.route<{ readonly Body: string }>({
    method: 'POST',
    url: ENDPOINT_URL,
    async handler(request, reply): Promise<FastifyReply<any>> {
      if (request.headers['content-type'] !== 'text/plain') {
        return reply.code(415).send();
      }

      const privateGatewayPublicKeyDigest = request.body;
      if (32 < privateGatewayPublicKeyDigest.length) {
        return reply.code(400).send({ message: 'Payload is not a SHA-256 digest' });
      }
      const authorizationSerialized = await generateAuthorization(
        privateGatewayPublicKeyDigest,
        ownPrivateKey,
      );
      return reply.header('Content-Type', PNRA_CONTENT_TYPE).send(authorizationSerialized);
    },
  });
}

async function generateAuthorization(
  privateGatewayPublicKeyDigest: string,
  ownPrivateKey: CryptoKey,
): Promise<Buffer> {
  const gatewayData = bufferToArray(Buffer.from(privateGatewayPublicKeyDigest));
  const tenSecondsInTheFuture = new Date();
  tenSecondsInTheFuture.setSeconds(tenSecondsInTheFuture.getSeconds() + 10);
  const authorization = new PrivateNodeRegistrationAuthorization(
    tenSecondsInTheFuture,
    gatewayData,
  );
  const authorizationSerialized = await authorization.serialize(ownPrivateKey);
  return Buffer.from(authorizationSerialized);
}
