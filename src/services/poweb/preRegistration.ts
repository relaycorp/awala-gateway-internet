import { PrivateNodeRegistrationAuthorization } from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { FastifyInstance, FastifyReply } from 'fastify';

import { registerDisallowedMethods } from '../../utilities/fastify';
import { CONTENT_TYPES } from './contentTypes';
import RouteOptions from './RouteOptions';

const ENDPOINT_URL = '/v1/pre-registrations';
const SHA256_HEX_DIGEST_LENGTH = 64;

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
      if (SHA256_HEX_DIGEST_LENGTH !== privateGatewayPublicKeyDigest.length) {
        return reply.code(400).send({ message: 'Payload is not a SHA-256 digest' });
      }

      const publicGatewayKeyPair = await options.keyPairRetriever();
      const authorizationSerialized = await generateAuthorization(
        privateGatewayPublicKeyDigest,
        publicGatewayKeyPair.privateKey,
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
  const gatewayData = bufferToArray(Buffer.from(privateGatewayPublicKeyDigest, 'hex'));
  const tenSecondsInTheFuture = new Date();
  tenSecondsInTheFuture.setSeconds(tenSecondsInTheFuture.getSeconds() + 10);
  const authorization = new PrivateNodeRegistrationAuthorization(
    tenSecondsInTheFuture,
    gatewayData,
  );
  const authorizationSerialized = await authorization.serialize(ownPrivateKey);
  return Buffer.from(authorizationSerialized);
}
