import {
  Certificate,
  derSerializePublicKey,
  issueGatewayCertificate,
  PrivateNodeRegistration,
  PrivateNodeRegistrationAuthorization,
  PrivateNodeRegistrationRequest,
  SessionKeyPair,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { FastifyInstance, FastifyReply } from 'fastify';
import { initVaultKeyStore } from '../../backingServices/vault';
import { MongoCertificateStore } from '../../keystores/MongoCertificateStore';
import { Config, ConfigKey } from '../../utilities/config';
import { sha256 } from '../../utilities/crypto';

import { registerDisallowedMethods } from '../fastify';
import { CONTENT_TYPES } from './contentTypes';

const ENDPOINT_URL = '/v1/nodes';

/**
 * Number of hours in the past, when the the private gateway's certificate validity should start.
 *
 * This is needed to account for clock drift.
 */
const PRIVATE_GATEWAY_CERTIFICATE_START_OFFSET_HOURS = 3;

const PRIVATE_GATEWAY_CERTIFICATE_VALIDITY_YEARS = 1;

export default async function registerRoutes(fastify: FastifyInstance): Promise<void> {
  registerDisallowedMethods(['POST'], ENDPOINT_URL, fastify);

  fastify.addContentTypeParser(
    CONTENT_TYPES.GATEWAY_REGISTRATION.REQUEST,
    { parseAs: 'buffer' },
    async (_req: any, rawBody: Buffer) => rawBody,
  );

  const privateKeyStore = initVaultKeyStore();

  fastify.route<{ readonly Body: Buffer }>({
    method: ['POST'],
    url: ENDPOINT_URL,
    async handler(request, reply): Promise<FastifyReply<any>> {
      if (request.headers['content-type'] !== CONTENT_TYPES.GATEWAY_REGISTRATION.REQUEST) {
        return reply.code(415).send();
      }

      let registrationRequest: PrivateNodeRegistrationRequest;
      try {
        registrationRequest = await PrivateNodeRegistrationRequest.deserialize(
          bufferToArray(request.body),
        );
      } catch (err) {
        request.log.info({ err }, 'Invalid PNRR received');
        return reply
          .code(400)
          .send({ message: 'Payload is not a valid Private Node Registration Request' });
      }

      const mongooseConnection = (fastify as any).mongo.db;
      const config = new Config(mongooseConnection);
      const privateAddress = await config.get(ConfigKey.CURRENT_PRIVATE_ADDRESS);
      const privateKey = await privateKeyStore.retrieveIdentityKey(privateAddress!!);

      const certificateStore = new MongoCertificateStore(mongooseConnection);
      const publicGatewayCertificate = await certificateStore.retrieveLatest(privateAddress!!);
      const gatewayPublicKey = await publicGatewayCertificate!!.getPublicKey();

      let registrationAuthorization: PrivateNodeRegistrationAuthorization;
      try {
        registrationAuthorization = await PrivateNodeRegistrationAuthorization.deserialize(
          registrationRequest.pnraSerialized,
          gatewayPublicKey,
        );
      } catch (err) {
        request.log.info({ err }, 'PNRR contains invalid authorization');
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
        privateKey,
        publicGatewayCertificate!!,
      );
      const sessionKeyPair = await SessionKeyPair.generate();
      await privateKeyStore.saveBoundSessionKey(
        sessionKeyPair.privateKey,
        sessionKeyPair.sessionKey.keyId,
        await privateGatewayCertificate.calculateSubjectPrivateAddress(),
      );
      const registration = new PrivateNodeRegistration(
        privateGatewayCertificate,
        publicGatewayCertificate!!,
        sessionKeyPair.sessionKey,
      );
      return reply
        .code(200)
        .header('Content-Type', CONTENT_TYPES.GATEWAY_REGISTRATION.REGISTRATION)
        .send(Buffer.from(await registration.serialize()));
    },
  });
}

async function issuePrivateGatewayCertificate(
  privateGatewayPublicKey: CryptoKey,
  publicGatewayPrivateKey: CryptoKey,
  publicGatewayCertificate: Certificate,
): Promise<Certificate> {
  const validityStartDate = new Date();
  validityStartDate.setHours(
    validityStartDate.getHours() - PRIVATE_GATEWAY_CERTIFICATE_START_OFFSET_HOURS,
  );
  const validityEndDate = new Date();
  validityEndDate.setFullYear(
    validityEndDate.getFullYear() + PRIVATE_GATEWAY_CERTIFICATE_VALIDITY_YEARS,
  );
  return issueGatewayCertificate({
    issuerCertificate: publicGatewayCertificate,
    issuerPrivateKey: publicGatewayPrivateKey,
    subjectPublicKey: privateGatewayPublicKey,
    validityEndDate,
    validityStartDate,
  });
}
