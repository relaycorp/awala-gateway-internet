import { FastifyInstance } from 'fastify';

import { configureFastify } from '../fastifyUtils';
import preRegistrationRoutes from './preRegistration';

/**
 * Initialize a Fastify server instance.
 *
 * This function doesn't call .listen() so we can use .inject() for testing purposes.
 */
export async function makeServer(): Promise<FastifyInstance> {
  return configureFastify([preRegistrationRoutes]);
}
