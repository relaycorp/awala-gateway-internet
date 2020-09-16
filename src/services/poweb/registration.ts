import {
  Certificate,
  derSerializePublicKey,
  issueGatewayCertificate,
  PrivateNodeRegistration,
  PrivateNodeRegistrationAuthorization,
  PrivateNodeRegistrationRequest,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { FastifyInstance, FastifyReply } from 'fastify';

import { sha256 } from '../../utils';
import { registerDisallowedMethods } from '../fastifyUtils';
import { CONTENT_TYPES } from './contentTypes';
import RouteOptions from './RouteOptions';

const ENDPOINT_URL = '/v1/nodes';

const PRIVATE_GATEWAY_CERTIFICATE_VALIDITY_YEARS = 3;

export default async function registerRoutes(
  fastify: FastifyInstance,
  options: RouteOptions,
): Promise<void> {
  registerDisallowedMethods(['POST'], ENDPOINT_URL, fastify);

  fastify.addContentTypeParser(
    CONTENT_TYPES.GATEWAY_REGISTRATION.REQUEST,
    { parseAs: 'buffer' },
    async (_req: any, rawBody: Buffer) => rawBody,
  );

  fastify.route<{ readonly Body: Buffer }>({
    method: ['POST'],
    url: ENDPOINT_URL,
    async handler(request, reply): Promise<FastifyReply<any>> {
      if (request.headers['content-type'] !== CONTENT_TYPES.GATEWAY_REGISTRATION.REQUEST) {
        return reply.code(415).send();
      }

      // tslint:disable-next-line:no-let
      let registrationRequest: PrivateNodeRegistrationRequest;
      try {
        registrationRequest = await PrivateNodeRegistrationRequest.deserialize(
          bufferToArray(request.body),
        );
      } catch (error) {
        return reply
          .code(400)
          .send({ message: 'Payload is not a valid Private Node Registration Request' });
      }

      // tslint:disable-next-line:no-let
      let registrationAuthorization: PrivateNodeRegistrationAuthorization;
      try {
        registrationAuthorization = await PrivateNodeRegistrationAuthorization.deserialize(
          registrationRequest.pnraSerialized,
          await options.publicGatewayCertificate.getPublicKey(),
        );
      } catch (error) {
        return reply
          .code(400)
          .send({ message: 'Registration request contains an invalid authorization' });
      }

      const privateGatewayPublicKeyDigest = sha256(
        await derSerializePublicKey(registrationRequest.privateNodePublicKey),
      );
      const authorizedPrivateGatewayKeyDigest = Buffer.from(registrationAuthorization.gatewayData);
      if (!privateGatewayPublicKeyDigest.equals(authorizedPrivateGatewayKeyDigest)) {
        return reply.code(403).send({
          message: 'Registration authorization was granted to a different private gateway',
        });
      }

      const privateGatewayCertificate = await issuePrivateGatewayCertificate(
        registrationRequest.privateNodePublicKey,
        options.publicGatewayPrivateKey,
        options.publicGatewayCertificate,
      );
      const registration = new PrivateNodeRegistration(
        privateGatewayCertificate,
        options.publicGatewayCertificate,
      );
      return reply
        .code(200)
        .header('Content-Type', CONTENT_TYPES.GATEWAY_REGISTRATION.REGISTRATION)
        .send(Buffer.from(registration.serialize()));
    },
  });
}

async function issuePrivateGatewayCertificate(
  privateGatewayPublicKey: CryptoKey,
  publicGatewayPrivateKey: CryptoKey,
  publicGatewayCertificate: Certificate,
): Promise<Certificate> {
  const validityEndDate = new Date();
  validityEndDate.setFullYear(
    validityEndDate.getFullYear() + PRIVATE_GATEWAY_CERTIFICATE_VALIDITY_YEARS,
  );
  return issueGatewayCertificate({
    issuerCertificate: publicGatewayCertificate,
    issuerPrivateKey: publicGatewayPrivateKey,
    subjectPublicKey: privateGatewayPublicKey,
    validityEndDate,
  });
}
