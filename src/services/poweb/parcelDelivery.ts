import {
  Certificate,
  DETACHED_SIGNATURE_TYPES,
  InvalidMessageError,
  Parcel,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { FastifyInstance, FastifyLoggerInstance, FastifyReply } from 'fastify';
import { Connection } from 'mongoose';

import { NatsStreamingClient } from '../../backingServices/natsStreaming';
import { retrieveOwnCertificates } from '../certs';
import { registerDisallowedMethods } from '../fastifyUtils';
import { ParcelStore } from '../parcelStore';
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

      // tslint:disable-next-line:no-let
      let parcel: Parcel;
      try {
        parcel = await Parcel.deserialize(parcelSerialized);
      } catch (error) {
        return reply.code(400).send({ message: 'Parcel is malformed' });
      }

      const peerGatewayAddress = await countersignerCertificate.calculateSubjectPrivateAddress();
      const natsStreamingClient = NatsStreamingClient.initFromEnv(
        `poweb-parcel-delivery-${request.id}`,
      );
      // tslint:disable-next-line:no-let
      let parcelObjectKey: string | null;
      try {
        parcelObjectKey = await parcelStore.storeParcelFromPeerGateway(
          parcel,
          request.body,
          peerGatewayAddress,
          mongooseConnection,
          natsStreamingClient,
        );
      } catch (err) {
        if (err instanceof InvalidMessageError) {
          request.log.info({ err, peerGatewayAddress }, 'Invalid parcel');
          return reply.code(403).send({ message: 'Parcel is invalid' });
        }

        request.log.error({ err, peerGatewayAddress }, 'Failed to save parcel');
        return reply.code(500).send({ message: 'Could not save parcel. Please try again later.' });
      }

      request.log.info({ parcelObjectKey, peerGatewayAddress }, 'Accepted parcel');
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
  try {
    return await DETACHED_SIGNATURE_TYPES.PARCEL_DELIVERY.verify(
      bufferToArray(countersignature),
      parcelSerialized,
      trustedCertificates,
    );
  } catch (error) {
    logger.debug({ error }, 'Invalid countersignature');
    return null;
  }
}
