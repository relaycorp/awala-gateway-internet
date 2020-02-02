import { get as getEnvVar } from 'env-var';
import { FastifyInstance } from 'fastify';

import routes from './routes';

// I wish I could just do `import * as fastify from 'fastify'` or `import fastify from 'fastify'`
// but neither worked regardless of the values set in esModuleInterop/allowSyntheticDefaultImports
import fastify = require('fastify');

const DEFAULT_REQUEST_ID_HEADER = 'X-Request-Id';
const SERVER_PORT = 8080;
const SERVER_HOST = '0.0.0.0';

/**
 * Initialize a Fastify server instance.
 *
 * This function doesn't call .listen() so we can use .inject() for testing purposes.
 */
export async function makeServer(): Promise<FastifyInstance> {
  const server = fastify({
    logger: true,
    requestIdHeader: getEnvVar('REQUEST_ID_HEADER', DEFAULT_REQUEST_ID_HEADER).asString(),
  });

  server.register(routes);

  const mongoUri = getEnvVar('MONGO_URI')
    .required()
    .asString();
  await server.register(require('fastify-mongoose'), { uri: mongoUri });

  server.addContentTypeParser(
    'application/vnd.relaynet.parcel',
    { parseAs: 'buffer' },
    async (_req: any, rawBody: Buffer) => rawBody,
  );

  await server.ready();

  return server;
}

export async function runServer(): Promise<void> {
  const server = await makeServer();

  await server.listen({ host: SERVER_HOST, port: SERVER_PORT });
}
