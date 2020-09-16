import { PrivateNodeRegistrationAuthorization } from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { FastifyInstance, FastifyReply } from 'fastify';

import { registerDisallowedMethods } from '../fastifyUtils';
import { CONTENT_TYPES } from './contentTypes';
import RouteOptions from './RouteOptions';

const ENDPOINT_URL = '/v1/pre-registrations';

export default async function registerRoutes(
  fastify: FastifyInstance,
  options: RouteOptions,
): Promise<void> {
  registerDisallowedMethods(['POST'], ENDPOINT_URL, fastify);

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
        options.publicGatewayPrivateKey,
      );
      return reply
        .header('Content-Type', CONTENT_TYPES.GATEWAY_REGISTRATION.AUTHORIZATION)
        .send(authorizationSerialized);
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
