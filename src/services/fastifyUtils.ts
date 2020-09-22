import { get as getEnvVar } from 'env-var';
import {
  fastify,
  FastifyInstance,
  FastifyLoggerOptions,
  FastifyPluginCallback,
  FastifyPluginOptions,
  HTTPMethods,
} from 'fastify';
import { Logger } from 'pino';
import { MAX_RAMF_MESSAGE_SIZE } from './constants';

const DEFAULT_REQUEST_ID_HEADER = 'X-Request-Id';
const SERVER_PORT = 8080;
const SERVER_HOST = '0.0.0.0';

export type FastifyLogger = boolean | FastifyLoggerOptions | Logger;

export const HTTP_METHODS: readonly HTTPMethods[] = [
  'POST',
  'DELETE',
  'GET',
  'HEAD',
  'PATCH',
  'PUT',
  'OPTIONS',
];

export function registerDisallowedMethods(
  allowedMethods: readonly HTTPMethods[],
  endpointURL: string,
  fastifyInstance: FastifyInstance,
): void {
  const allowedMethodsString = allowedMethods.join(', ');

  const methods = HTTP_METHODS.filter((m) => !allowedMethods.includes(m));

  fastifyInstance.route({
    method: methods,
    url: endpointURL,
    async handler(req, reply): Promise<void> {
      const statusCode = req.method === 'OPTIONS' ? 204 : 405;
      reply.code(statusCode).header('Allow', allowedMethodsString).send();
    },
  });
}

/**
 * Initialize a Fastify server instance.
 *
 * This function doesn't call .listen() so we can use .inject() for testing purposes.
 */
export async function configureFastify<RouteOptions extends FastifyPluginOptions = {}>(
  routes: ReadonlyArray<FastifyPluginCallback<RouteOptions>>,
  routeOptions?: RouteOptions,
  logger: FastifyLogger = true,
): Promise<FastifyInstance> {
  const server = fastify({
    bodyLimit: MAX_RAMF_MESSAGE_SIZE,
    logger,
    requestIdHeader: getEnvVar('REQUEST_ID_HEADER')
      .default(DEFAULT_REQUEST_ID_HEADER)
      .asString()
      .toLowerCase(),
    trustProxy: true,
  });

  await Promise.all(routes.map((route) => server.register(route, routeOptions)));

  const mongoUri = getEnvVar('MONGO_URI').required().asString();
  await server.register(require('fastify-mongoose'), { uri: mongoUri });

  await server.ready();

  return server;
}

export async function runFastify(fastifyInstance: FastifyInstance): Promise<void> {
  await fastifyInstance.listen({ host: SERVER_HOST, port: SERVER_PORT });
}
