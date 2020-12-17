import { get as getEnvVar } from 'env-var';
import {
  fastify,
  FastifyInstance,
  FastifyLoggerOptions,
  FastifyPluginCallback,
  FastifyPluginOptions,
  HTTPMethods,
} from 'fastify';
import { Connection } from 'mongoose';
import { Logger } from 'pino';

import { getMongooseConnectionArgsFromEnv } from '../backingServices/mongo';
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
  mongoAppName?: string,
): Promise<FastifyInstance> {
  const server = fastify({
    bodyLimit: MAX_RAMF_MESSAGE_SIZE,
    logger: getFinalLogger(logger),
    requestIdHeader: getEnvVar('REQUEST_ID_HEADER')
      .default(DEFAULT_REQUEST_ID_HEADER)
      .asString()
      .toLowerCase(),
    trustProxy: true,
  });

  const mongoConnectionArgs = getMongooseConnectionArgsFromEnv();
  server.log.debug('Before configuring fastify-mongoose');
  await server.register(require('fastify-mongoose'), {
    ...mongoConnectionArgs.options,
    appname: `relaynet-internet-gateway${mongoAppName ? `-${mongoAppName}` : ''}`,
    bufferCommands: false,
    bufferMaxEntries: 0,
    connectTimeoutMS: 10_000,
    maxIdleTimeMS: 60_000,
    socketTimeoutMS: 5_000,
    uri: mongoConnectionArgs.uri,
    waitQueueTimeoutMS: 5_000,
  });
  server.log.debug('Before listening for Mongoose events');
  const mongooseConnection = (server as any).mongo.db as Connection;
  (mongooseConnection as any).set('debug', true);
  mongooseConnection.on('connecting', () => {
    server.log.debug('Mongoose connecting');
  });
  mongooseConnection.on('connected', () => {
    server.log.debug('Mongoose connected');
  });
  mongooseConnection.on('disconnecting', () => {
    server.log.debug('Mongoose disconnecting');
  });
  mongooseConnection.on('disconnected', () => {
    server.log.debug('Mongoose disconnected');
  });
  mongooseConnection.on('reconnected', () => {
    server.log.debug('Mongoose reconnected');
  });
  mongooseConnection.on('error', (err) => {
    server.log.error({ err }, 'Mongoose error');
  });
  mongooseConnection.on('fullsetup', () => {
    server.log.debug('Mongoose fullsetup');
  });
  mongooseConnection.on('all', () => {
    server.log.debug('Mongoose all');
  });
  mongooseConnection.on('reconnectFailed', () => {
    server.log.debug('Mongoose reconnectFailed');
  });

  await Promise.all(routes.map((route) => server.register(route, routeOptions)));

  await server.ready();

  return server;
}

function getFinalLogger(logger: FastifyLogger): FastifyLogger {
  if (logger !== true) {
    return logger;
  }
  const logLevelEnvVar = getEnvVar('LOG_LEVEL').asString()?.toLowerCase();
  return logLevelEnvVar ? { level: logLevelEnvVar } : logger;
}

export async function runFastify(fastifyInstance: FastifyInstance): Promise<void> {
  await fastifyInstance.listen({ host: SERVER_HOST, port: SERVER_PORT });
}
