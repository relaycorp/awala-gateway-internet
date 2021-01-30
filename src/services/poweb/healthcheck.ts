import { FastifyInstance } from 'fastify';

import { registerDisallowedMethods } from '../../utilities/fastify';

export default async function registerRoutes(
  fastify: FastifyInstance,
  _options: any,
): Promise<void> {
  registerDisallowedMethods(['HEAD', 'GET'], '/', fastify);

  fastify.route({
    method: ['HEAD', 'GET'],
    url: '/',
    async handler(_req, reply): Promise<void> {
      reply
        .code(200)
        .header('Content-Type', 'text/plain')
        .send('Success! The PoWeb service works.');
    },
  });
}
