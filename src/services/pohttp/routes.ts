import { InvalidMessageError, Parcel } from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { get as getEnvVar } from 'env-var';
import { FastifyInstance, FastifyReply } from 'fastify';

import { NatsStreamingClient } from '../../backingServices/natsStreaming';
import { registerDisallowedMethods } from '../fastifyUtils';
import { ParcelStore } from '../parcelStore';

export default async function registerRoutes(
  fastify: FastifyInstance,
  _options: any,
): Promise<void> {
  const natsServerUrl = getEnvVar('NATS_SERVER_URL').required().asString();
  const natsClusterId = getEnvVar('NATS_CLUSTER_ID').required().asString();

  const parcelStore = ParcelStore.initFromEnv();

  fastify.addContentTypeParser(
    'application/vnd.relaynet.parcel',
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

  fastify.route<{ readonly Body: Buffer }>({
    method: 'POST',
    url: '/',
    async handler(request, reply): Promise<FastifyReply<any>> {
      if (request.headers['content-type'] !== 'application/vnd.relaynet.parcel') {
        return reply.code(415).send();
      }

      // tslint:disable-next-line:no-let
      let parcel;
      try {
        parcel = await Parcel.deserialize(bufferToArray(request.body));
      } catch (error) {
        return reply.code(400).send({ message: 'Payload is not a valid RAMF-serialized parcel' });
      }

      if (!parcel.isRecipientAddressPrivate) {
        return reply
          .code(400)
          .send({ message: 'Parcel recipient should be specified as a private address' });
      }

      // TODO: Use NatsStreamingClient.initFromEnv() outside this handler closure
      const natsClient = new NatsStreamingClient(
        natsServerUrl,
        natsClusterId,
        `pohttp-req-${request.id}`,
      );
      try {
        await parcelStore.storeGatewayBoundParcel(
          parcel,
          request.body,
          (fastify as any).mongo.db,
          natsClient,
        );
      } catch (error) {
        if (error instanceof InvalidMessageError) {
          return reply.code(403).send({ message: 'The parcel is invalid' });
        } else {
          request.log.error({ err: error }, 'Failed to save parcel in object storage');
          return reply
            .code(500)
            .send({ message: 'Parcel could not be stored; please try again later' });
        }
      }

      return reply.code(202).send({});
    },
  });
}
