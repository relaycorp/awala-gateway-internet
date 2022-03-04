import {
  Certificate,
  InvalidMessageError,
  Parcel,
  ParcelDeliveryVerifier,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { FastifyInstance, FastifyLoggerInstance, FastifyReply } from 'fastify';
import { Connection } from 'mongoose';

import { NatsStreamingClient } from '../../backingServices/natsStreaming';
import { ParcelStore } from '../../parcelStore';
import { retrieveOwnCertificates } from '../../pki';
import { registerDisallowedMethods } from '../fastify';
import { CONTENT_TYPES } from './contentTypes';
import RouteOptions from './RouteOptions';

const ENDPOINT_URL = '/v1/parcels';

export default async function registerRoutes(
  fastify: FastifyInstance,
  _options: RouteOptions,
): Promise<void> {
  const parcelStore = ParcelStore.initFromEnv();

  registerDisallowedMethods(['POST'], ENDPOINT_URL, fastify);

  fastify.addContentTypeParser(
    CONTENT_TYPES.PARCEL,
    { parseAs: 'buffer' },
    async (_req: any, rawBody: Buffer) => rawBody,
  );

  fastify.route<{ readonly Body: Buffer }>({
    method: ['POST'],
    url: ENDPOINT_URL,
    async handler(request, reply): Promise<FastifyReply<any>> {
      if (request.headers['content-type'] !== CONTENT_TYPES.PARCEL) {
        return reply.code(415).send();
      }

      const parcelSerialized = bufferToArray(request.body);
      const mongooseConnection = (fastify as any).mongo.db;
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

      const peerGatewayAddress = await countersignerCertificate.calculateSubjectPrivateAddress();
      const parcelAwareLogger = request.log.child({ parcelId: parcel.id, peerGatewayAddress });

      parcelAwareLogger.debug('Parcel is well-formed');

      const natsStreamingClient = NatsStreamingClient.initFromEnv(
        `poweb-parcel-delivery-${request.id}`,
      );
      let parcelObjectKey: string | null;
      try {
        parcelObjectKey = await parcelStore.storeParcelFromPeerGateway(
          parcel,
          request.body,
          peerGatewayAddress,
          mongooseConnection,
          natsStreamingClient,
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

      parcelAwareLogger.info({ parcelObjectKey }, 'Parcel was successfully stored');
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
    return null;
  }
  const countersignature = Buffer.from(countersignatureBase64, 'base64');
  if (countersignature.byteLength === 0) {
    // The base64-encoded countersignature was empty or malformed
    return null;
  }
  const trustedCertificates = await retrieveOwnCertificates(mongooseConnection);
  const verifier = new ParcelDeliveryVerifier(trustedCertificates);
  try {
    return await verifier.verify(bufferToArray(countersignature), parcelSerialized);
  } catch (err) {
    logger.debug({ err }, 'Invalid countersignature');
    return null;
  }
}
