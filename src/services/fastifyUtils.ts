import { get as getEnvVar } from 'env-var';
import { fastify, FastifyInstance, FastifyPluginCallback } from 'fastify';

const DEFAULT_REQUEST_ID_HEADER = 'X-Request-Id';
const SERVER_PORT = 8080;
const SERVER_HOST = '0.0.0.0';

/**
 * Initialize a Fastify server instance.
 *
 * This function doesn't call .listen() so we can use .inject() for testing purposes.
 */
export async function configureFastify(routes: FastifyPluginCallback): Promise<FastifyInstance> {
  const server = fastify({
    logger: true,
    requestIdHeader: getEnvVar('REQUEST_ID_HEADER').default(DEFAULT_REQUEST_ID_HEADER).asString(),
  });

  server.register(routes);

  const mongoUri = getEnvVar('MONGO_URI').required().asString();
  await server.register(require('fastify-mongoose'), { uri: mongoUri });

  await server.ready();

  return server;
}

export async function runFastify(fastifyInstance: FastifyInstance): Promise<void> {
  await fastifyInstance.listen({ host: SERVER_HOST, port: SERVER_PORT });
}
