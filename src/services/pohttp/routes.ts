import { Parcel } from '@relaycorp/relaynet-core';
import { mongoose } from '@typegoose/typegoose';
import { createHash } from 'crypto';
import { get as getEnvVar } from 'env-var';
import { FastifyInstance, FastifyReply } from 'fastify';

import { NatsStreamingClient } from '../../backingServices/natsStreaming';
import { ObjectStoreClient } from '../../backingServices/objectStorage';
import { retrieveOwnCertificates } from '../certs';

const GATEWAY_BOUND_OBJECT_KEY_PREFIX = 'parcels/gateway-bound';

export default async function registerRoutes(
  fastify: FastifyInstance,
  _options: any,
): Promise<void> {
  const natsServerUrl = getEnvVar('NATS_SERVER_URL')
    .required()
    .asString();
  const natsClusterId = getEnvVar('NATS_CLUSTER_ID')
    .required()
    .asString();

  const objectStoreClient = ObjectStoreClient.initFromEnv();
  const objectStoreBucket = getEnvVar('OBJECT_STORAGE_BUCKET')
    .required()
    .asString();

  fastify.route({
    method: ['PUT', 'DELETE', 'PATCH'],
    url: '/',
    async handler(_req, reply): Promise<void> {
      reply
        .code(405)
        .header('Allow', 'HEAD, GET, POST')
        .send();
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
        parcel = await Parcel.deserialize(request.body);
      } catch (error) {
        return reply.code(400).send({ message: 'Payload is not a valid RAMF-serialized parcel' });
      }

      // @ts-ignore
      const mongooseConnection = (fastify.mongo as unknown) as { readonly db: mongoose.Connection };
      const trustedCertificates = await retrieveOwnCertificates(mongooseConnection.db);
      try {
        await parcel.validate(trustedCertificates);
      } catch (error) {
        // See: https://github.com/relaycorp/relaynet-internet-gateway/issues/15
        // tslint:disable-next-line:no-console
        console.log({
          attachedChain: await Promise.all(
            parcel.senderCaCertificateChain.map(c => c.calculateSubjectPrivateAddress()),
          ),
          certPath: await Promise.all(
            (await parcel.getSenderCertificationPath(trustedCertificates)).map(c =>
              c.calculateSubjectPrivateAddress(),
            ),
          ),
          err: error.message,
          recipient: parcel.recipientAddress,
          sender: await parcel.senderCertificate.calculateSubjectPrivateAddress(),
          trusted: await Promise.all(
            trustedCertificates.map(c => c.calculateSubjectPrivateAddress()),
          ),
        });
        // return reply.code(400).send({ message: 'Parcel sender is not authorized' });
      }

      //endregion

      const certificatePath = await parcel.getSenderCertificationPath(trustedCertificates);
      const recipientGatewayCert = certificatePath[0];
      const recipientGatewayAddress = await recipientGatewayCert.calculateSubjectPrivateAddress();

      //region Save to object storage
      const parcelObjectKey = await calculateParcelObjectKey(parcel, recipientGatewayAddress);
      const parcelObject = {
        body: request.body,
        metadata: { 'parcel-expiry': convertDateToTimestamp(parcel.expiryDate).toString() },
      };
      try {
        await objectStoreClient.putObject(parcelObject, parcelObjectKey, objectStoreBucket);
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

async function calculateParcelObjectKey(
  parcel: Parcel,
  recipientGatewayAddress: string,
): Promise<string> {
  const senderPrivateAddress = await parcel.senderCertificate.calculateSubjectPrivateAddress();
  return [
    GATEWAY_BOUND_OBJECT_KEY_PREFIX,
    recipientGatewayAddress,
    parcel.recipientAddress,
    senderPrivateAddress,
    sha256Hex(parcel.id), // Use the digest to avoid using potentially illegal characters
  ].join('/');
}

function convertDateToTimestamp(expiryDate: Date): number {
  return Math.floor(expiryDate.getTime() / 1_000);
}

function sha256Hex(plaintext: string): string {
  return createHash('sha256')
    .update(plaintext)
    .digest('hex');
}
