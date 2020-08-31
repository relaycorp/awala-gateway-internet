import { get as getEnvVar } from 'env-var';
import { FastifyInstance } from 'fastify';

import { initVaultKeyStore } from '../../backingServices/privateKeyStore';
import { configureFastify } from '../fastifyUtils';
import preRegistrationRoutes from './preRegistration';
import RouteOptions from './RouteOptions';

/**
 * Initialize a Fastify server instance.
 *
 * This function doesn't call .listen() so we can use .inject() for testing purposes.
 */
export async function makeServer(): Promise<FastifyInstance> {
  const gatewayKeyIdBase64 = getEnvVar('GATEWAY_KEY_ID').required().asString();
  const gatewayKeyId = Buffer.from(gatewayKeyIdBase64, 'base64');
  const privateKeyStore = initVaultKeyStore();
  const publicGatewayKeyPair = await privateKeyStore.fetchNodeKey(gatewayKeyId);
  const routeOptions: RouteOptions = {
    publicGatewayCertificate: publicGatewayKeyPair.certificate,
    publicGatewayPrivateKey: publicGatewayKeyPair.privateKey,
  };
  return configureFastify([preRegistrationRoutes], routeOptions);
}
