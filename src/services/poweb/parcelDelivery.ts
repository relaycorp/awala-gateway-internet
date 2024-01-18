import {
  Certificate,
  InvalidMessageError,
  Parcel,
  ParcelDeliveryVerifier,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { FastifyInstance, FastifyLoggerInstance, FastifyReply } from 'fastify';
import { Connection } from 'mongoose';

import { ParcelStore } from '../../parcelStore';
import { retrieveOwnCertificates } from '../../pki';
import { registerDisallowedMethods } from '../../utilities/fastify/server';
import { CONTENT_TYPES } from './contentTypes';
import { RedisPubSubClient } from '../../backingServices/RedisPubSubClient';
import { QueueEmitter } from '../../utilities/backgroundQueue/QueueEmitter';

const ENDPOINT_URL = '/v1/parcels';

export default async function registerRoutes(fastify: FastifyInstance): Promise<void> {
  const parcelStore = ParcelStore.initFromEnv();

  registerDisallowedMethods(['POST'], ENDPOINT_URL, fastify);

  fastify.addContentTypeParser(
    CONTENT_TYPES.PARCEL,
    { parseAs: 'buffer' },
    async (_req: any, rawBody: Buffer) => rawBody,
  );

  const redisPublisher = await RedisPubSubClient.init().makePublisher();
  fastify.addHook('onClose', async () => redisPublisher.close());

  const emitter = await QueueEmitter.init();

  fastify.route<{ readonly Body: Buffer }>({
    method: ['POST'],
    url: ENDPOINT_URL,
    async handler(request, reply): Promise<FastifyReply<any>> {
      if (request.headers['content-type'] !== CONTENT_TYPES.PARCEL) {
        return reply.code(415).send();
      }

      const parcelSerialized = bufferToArray(request.body);
      const mongooseConnection = (fastify as any).mongoose;
      const countersignerCertificate = await verifyCountersignature(
        parcelSerialized,
        request.headers.authorization,
        mongooseConnection,
        request.log,
      );
      if (!countersignerCertificate) {
        return reply
          .code(401)
          .header('www-authenticate', 'Relaynet-Countersignature')
          .send({ message: 'Parcel delivery countersignature is either missing or invalid' });
      }

      let parcel: Parcel;
      try {
        parcel = await Parcel.deserialize(parcelSerialized);
      } catch (error) {
        return reply.code(400).send({ message: 'Parcel is malformed' });
      }

      const privatePeerId = await countersignerCertificate.calculateSubjectId();
      const parcelAwareLogger = request.log.child({ parcelId: parcel.id, privatePeerId });

      let wasParcelSuccessfullyStored: boolean;
      try {
        wasParcelSuccessfullyStored = await parcelStore.storeParcelFromPrivatePeer(
          parcel,
          request.body,
          privatePeerId,
          mongooseConnection,
          emitter,
          redisPublisher.publish,
          parcelAwareLogger,
        );
      } catch (err) {
        if (err instanceof InvalidMessageError) {
          parcelAwareLogger.info({ err }, 'Invalid parcel');
          return reply.code(422).send({ message: 'Parcel is invalid' });
        }

        parcelAwareLogger.error({ err }, 'Failed to save parcel');
        return reply.code(500).send({ message: 'Could not save parcel. Please try again later.' });
      }

      const logMessage = wasParcelSuccessfullyStored
        ? 'Parcel was successfully stored'
        : 'Parcel was previously stored';
      parcelAwareLogger.info(logMessage);
      return reply.code(202).send();
    },
  });
}

async function verifyCountersignature(
  parcelSerialized: ArrayBuffer,
  authorizationHeader: string | undefined,
  mongooseConnection: Connection,
  logger: FastifyLoggerInstance,
): Promise<Certificate | null> {
  const [authorizationType, countersignatureBase64] = (authorizationHeader || '').split(' ', 2);
  if (authorizationType !== 'Relaynet-Countersignature') {
    logger.info('Refused parcel due to missing countersignature');
    return null;
  }
  const countersignature = Buffer.from(countersignatureBase64, 'base64');
  if (countersignature.byteLength === 0) {
    logger.info('Refused parcel due to malformed countersignature');
    return null;
  }
  const trustedCertificates = await retrieveOwnCertificates(mongooseConnection);
  const verifier = new ParcelDeliveryVerifier(trustedCertificates);
  try {
    return await verifier.verify(bufferToArray(countersignature), parcelSerialized);
  } catch (err) {
    logger.info({ err }, 'Refused parcel due to invalid countersignature');
    return null;
  }
}
