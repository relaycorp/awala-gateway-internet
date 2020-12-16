import { UnboundKeyPair } from '@relaycorp/relaynet-core';
import { get as getEnvVar } from 'env-var';
import { FastifyInstance, FastifyPluginCallback } from 'fastify';

import { initVaultKeyStore } from '../../backingServices/keyStores';
import { configureFastify, FastifyLogger } from '../fastifyUtils';
import healthcheck from './healthcheck';
import parcelCollection from './parcelCollection';
import parcelDelivery from './parcelDelivery';
import preRegistrationRoutes from './preRegistration';
import registrationRoutes from './registration';
import RouteOptions from './RouteOptions';

const ROUTES: ReadonlyArray<FastifyPluginCallback<RouteOptions>> = [
  healthcheck,
  parcelCollection,
  parcelDelivery,
  preRegistrationRoutes,
  registrationRoutes,
];

/**
 * Initialize a Fastify server instance.
 *
 * This function doesn't call .listen() so we can use .inject() for testing purposes.
 */
export async function makeServer(logger?: FastifyLogger): Promise<FastifyInstance> {
  return configureFastify(
    ROUTES,
    {
      keyPairRetriever: makeKeyPairRetriever(),
    },
    logger,
  );
}

function makeKeyPairRetriever(): () => Promise<UnboundKeyPair> {
  const gatewayKeyIdBase64 = getEnvVar('GATEWAY_KEY_ID').required().asString();
  const gatewayKeyId = Buffer.from(gatewayKeyIdBase64, 'base64');
  const privateKeyStore = initVaultKeyStore();
  return () => privateKeyStore.fetchNodeKey(gatewayKeyId);
}
