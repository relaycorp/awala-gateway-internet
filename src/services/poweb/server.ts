import { get as getEnvVar } from 'env-var';
import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import type { BaseLogger } from 'pino';

import { configureFastify } from '../../utilities/fastify/server';
import type { PowebRouteOptions } from './PowebRouteOptions';
import healthcheck from './healthcheck';
import connectionParams from './connectionParams';
import parcelCollection from './parcelCollection';
import parcelDelivery from './parcelDelivery';
import preRegistrationRoutes from './preRegistration';
import registrationRoutes from './registration';

const ROUTES: ReadonlyArray<FastifyPluginCallback<PowebRouteOptions>> = [
  healthcheck,
  connectionParams,
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
export async function makeServer(logger?: BaseLogger): Promise<FastifyInstance> {
  const internetAddress = getEnvVar('INTERNET_ADDRESS').required().asString();
  return configureFastify(ROUTES, { internetAddress }, logger);
}
