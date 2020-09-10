import { FastifyInstance } from 'fastify';

import { registerDisallowedMethods } from '../fastifyUtils';
import RouteOptions from './RouteOptions';

const ENDPOINT_URL = '/v1/parcels';

export default async function registerRoutes(
  fastify: FastifyInstance,
  _options: RouteOptions,
): Promise<void> {
  registerDisallowedMethods(['POST'], ENDPOINT_URL, fastify);
}
