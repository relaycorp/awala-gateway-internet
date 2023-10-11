import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import type { BaseLogger } from 'pino';

import { configureFastify } from '../../utilities/fastify/server';
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
export async function makeServer(logger?: BaseLogger): Promise<FastifyInstance> {
  return configureFastify(ROUTES, {}, logger);
}
