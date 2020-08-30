import { PrivateNodeRegistrationAuthorization } from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { get as getEnvVar } from 'env-var';
import { FastifyInstance, FastifyReply } from 'fastify';

import { initVaultKeyStore } from '../../backingServices/privateKeyStore';

const ENDPOINT_URL = '/v1/pre-registrations';

export default async function registerRoutes(
  fastify: FastifyInstance,
  _options: any,
): Promise<void> {
  const ownPrivateKey = await retrieveOwnPrivateKey();

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
      return reply
        .header('Content-Type', 'application/vnd.relaynet.node-registration.authorization')
        .send(authorizationSerialized);
    },
  });
}

async function retrieveOwnPrivateKey(): Promise<CryptoKey> {
  const gatewayKeyIdBase64 = getEnvVar('GATEWAY_KEY_ID').required().asString();
  const gatewayKeyId = Buffer.from(gatewayKeyIdBase64, 'base64');
  const privateKeyStore = initVaultKeyStore();
  const unboundKeyPair = await privateKeyStore.fetchNodeKey(gatewayKeyId);
  return unboundKeyPair.privateKey;
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
