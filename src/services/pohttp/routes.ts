import { InvalidMessageError, Parcel } from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { FastifyInstance, FastifyReply } from 'fastify';

import { ParcelStore } from '../../parcelStore';
import { registerDisallowedMethods } from '../../utilities/fastify/server';
import { RedisPubSubClient } from '../../backingServices/RedisPubSubClient';

export default async function registerRoutes(
  fastify: FastifyInstance,
  _options: any,
): Promise<void> {
  const parcelStore = ParcelStore.initFromEnv();

  fastify.addContentTypeParser(
    'application/vnd.awala.parcel',
    { parseAs: 'buffer' },
    async (_req: any, rawBody: Buffer) => rawBody,
  );

  registerDisallowedMethods(['HEAD', 'GET', 'POST'], '/', fastify);

  fastify.route({
    method: ['HEAD', 'GET'],
    url: '/',
    async handler(_req, reply): Promise<void> {
      reply
        .code(200)
        .header('Content-Type', 'text/plain')
        .send('Success! This PoHTTP endpoint for the gateway works.');
    },
  });

  const redisPublisher = await RedisPubSubClient.init().makePublisher();
  fastify.addHook('onClose', async () => redisPublisher.close());

  fastify.route<{ readonly Body: Buffer }>({
    method: 'POST',
    url: '/',
    async handler(request, reply): Promise<FastifyReply<any>> {
      if (request.headers['content-type'] !== 'application/vnd.awala.parcel') {
        return reply.code(415).send();
      }

      let parcel;
      try {
        parcel = await Parcel.deserialize(bufferToArray(request.body));
      } catch (error) {
        return reply.code(400).send({ message: 'Payload is not a valid RAMF-serialized parcel' });
      }

      const parcelAwareLogger = request.log.child({ parcelId: parcel.id });

      try {
        await parcelStore.storeParcelForPrivatePeer(
          parcel,
          request.body,
          (fastify as any).mongoose,
          redisPublisher.publish,
          parcelAwareLogger,
        );
      } catch (err) {
        if (err instanceof InvalidMessageError) {
          parcelAwareLogger.info({ err }, 'Invalid parcel');
          const message = `Invalid parcel: ${err.message}`;
          return reply.code(403).send({ message });
        } else {
          parcelAwareLogger.error({ err }, 'Failed to save parcel in object storage');
          return reply
            .code(500)
            .send({ message: 'Parcel could not be stored; please try again later' });
        }
      }

      parcelAwareLogger.info('Parcel accepted');
      return reply.code(202).send({});
    },
  });
}
