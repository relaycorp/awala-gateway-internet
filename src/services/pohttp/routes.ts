import { Parcel } from '@relaycorp/relaynet-core';
import { mongoose } from '@typegoose/typegoose';
import bufferToArray from 'buffer-to-arraybuffer';
import { get as getEnvVar } from 'env-var';
import { FastifyInstance, FastifyReply } from 'fastify';

import { NatsStreamingClient } from '../../backingServices/natsStreaming';
import { ObjectStoreClient } from '../../backingServices/objectStorage';
import { retrieveOwnCertificates } from '../certs';
import { ParcelStore } from '../parcelStore';

export default async function registerRoutes(
  fastify: FastifyInstance,
  _options: any,
): Promise<void> {
  const natsServerUrl = getEnvVar('NATS_SERVER_URL').required().asString();
  const natsClusterId = getEnvVar('NATS_CLUSTER_ID').required().asString();

  const objectStoreClient = ObjectStoreClient.initFromEnv();
  const objectStoreBucket = getEnvVar('OBJECT_STORE_BUCKET').required().asString();
  const parcelStore = new ParcelStore(objectStoreClient, objectStoreBucket);

  fastify.route({
    method: ['PUT', 'DELETE', 'PATCH'],
    url: '/',
    async handler(_req, reply): Promise<void> {
      reply.code(405).header('Allow', 'HEAD, GET, POST').send();
    },
  });

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

  fastify.route({
    method: 'POST',
    url: '/',
    async handler(request, reply): Promise<FastifyReply<any>> {
      if (request.headers['content-type'] !== 'application/vnd.relaynet.parcel') {
        return reply.code(415).send();
      }

      //region Validate the parcel

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

      // @ts-ignore
      const mongooseConnection = (fastify.mongo as unknown) as { readonly db: mongoose.Connection };
      const trustedCertificates = await retrieveOwnCertificates(mongooseConnection.db);
      try {
        await parcel.validate(trustedCertificates);
      } catch (error) {
        // TODO: Log this
        return reply.code(400).send({ message: 'Parcel sender is not authorized' });
      }

      //endregion

      const certificatePath = await parcel.getSenderCertificationPath(trustedCertificates);
      const recipientGatewayCert = certificatePath[certificatePath.length - 2];
      const recipientGatewayAddress = await recipientGatewayCert.calculateSubjectPrivateAddress();

      //region Save to object storage
      // tslint:disable-next-line:no-let
      let parcelObjectKey: string;
      try {
        parcelObjectKey = await parcelStore.storeGatewayBoundParcel(
          parcel,
          request.body,
          recipientGatewayAddress,
        );
      } catch (error) {
        request.log.error({ err: error }, 'Failed to save parcel in object storage');
        return reply
          .code(500)
          .send({ message: 'Parcel could not be stored; please try again later' });
      }
      //region

      //region Notify subscribers
      // TODO: Try to reuse the NATS client within the process, if the client is concurrency-safe
      const natsClient = new NatsStreamingClient(
        natsServerUrl,
        natsClusterId,
        `pohttp-req-${request.id}`,
      );
      try {
        await natsClient.publishMessage(parcelObjectKey, `pdc-parcel.${recipientGatewayAddress}`);
      } catch (error) {
        request.log.error({ err: error }, 'Failed to queue ping message');
        return reply
          .code(500)
          .send({ message: 'Parcel could not be stored; please try again later' });
      } finally {
        natsClient.disconnect();
      }
      //endregion

      return reply.code(202).send({});
    },
  });
}
