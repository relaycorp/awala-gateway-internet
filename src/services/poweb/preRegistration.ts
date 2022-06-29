import { PrivateNodeRegistrationAuthorization } from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { FastifyInstance, FastifyReply } from 'fastify';
import { initPrivateKeyStore } from '../../backingServices/keystore';
import { Config, ConfigKey } from '../../utilities/config';

import { registerDisallowedMethods } from '../fastify';
import { CONTENT_TYPES } from './contentTypes';

const ENDPOINT_URL = '/v1/pre-registrations';
const SHA256_HEX_DIGEST_LENGTH = 64;

export default async function registerRoutes(fastify: FastifyInstance): Promise<void> {
  registerDisallowedMethods(['POST'], ENDPOINT_URL, fastify);

  const privateKeyStore = initPrivateKeyStore();

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

      const config = new Config((fastify as any).mongoose);
      const privateAddress = await config.get(ConfigKey.CURRENT_PRIVATE_ADDRESS);
      const privateKey = await privateKeyStore.retrieveIdentityKey(privateAddress!!);
      const authorizationSerialized = await generateAuthorization(
        privateGatewayPublicKeyDigest,
        privateKey!,
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
