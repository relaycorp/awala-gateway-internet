import { FastifyInstance } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import mongoose from 'mongoose';

export interface FastifyMongooseOptions {
  readonly connection: mongoose.Connection;
}

async function fastifyMongoose(
  fastify: FastifyInstance,
  options: FastifyMongooseOptions,
): Promise<void> {
  if (!options.connection) {
    throw new Error('Mongoose connection is missing from fastify-mongoose plugin registration');
  }

  fastify.addHook('onClose', async () => {
    await options.connection.close();
  });

  fastify.decorate('mongoose', options.connection);
}

export default fastifyPlugin(fastifyMongoose, { name: 'fastify-mongoose' });
