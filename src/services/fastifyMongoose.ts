import { FastifyInstance } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { ConnectOptions, createConnection } from 'mongoose';

export interface FastifyMongooseOptions {
  readonly uri: string;
  readonly options?: ConnectOptions;
}

async function fastifyMongoose(
  fastify: FastifyInstance,
  options: FastifyMongooseOptions,
): Promise<void> {
  if (!options.uri) {
    throw new Error('MongoDB URI is missing from fastify-mongoose plugin registration');
  }

  const connection = await createConnection(options.uri, options.options ?? {}).asPromise();

  fastify.addHook('onClose', async () => {
    await connection.close();
  });

  fastify.decorate('mongoose', connection);
}

export default fastifyPlugin(fastifyMongoose, { name: 'fastify-mongoose' });
