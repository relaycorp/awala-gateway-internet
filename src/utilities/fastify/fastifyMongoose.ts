import type { FastifyInstance, RouteOptions } from 'fastify';
import fastifyPlugin from 'fastify-plugin';

import { createMongooseConnectionFromEnv } from '../../backingServices/mongo';
import type { PluginDone } from './PluginDone';

function fastifyMongoose(fastify: FastifyInstance, _opts: RouteOptions, done: PluginDone): void {
  const mongooseConnection = createMongooseConnectionFromEnv();

  fastify.addHook('onClose', async () => {
    await mongooseConnection.close();
  });

  fastify.decorate('mongoose', mongooseConnection);

  done();
}

const fastifyMongoosePlugin = fastifyPlugin(fastifyMongoose, { name: 'fastify-mongoose' });
export default fastifyMongoosePlugin;
