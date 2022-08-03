import {
  derSerializePublicKey,
  PrivateNodeRegistration,
  PrivateNodeRegistrationAuthorization,
  PrivateNodeRegistrationRequest,
  SessionKeyPair,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { FastifyInstance, FastifyReply } from 'fastify';

import { initPrivateKeyStore } from '../../backingServices/keystore';
import { MongoCertificateStore } from '../../keystores/MongoCertificateStore';
import { issuePrivateGatewayCertificate } from '../../pki';
import { Config, ConfigKey } from '../../utilities/config';
import { sha256 } from '../../utilities/crypto';
import { registerDisallowedMethods } from '../fastify';
import { CONTENT_TYPES } from './contentTypes';

const ENDPOINT_URL = '/v1/nodes';

export default async function registerRoutes(fastify: FastifyInstance): Promise<void> {
  registerDisallowedMethods(['POST'], ENDPOINT_URL, fastify);

  fastify.addContentTypeParser(
    CONTENT_TYPES.GATEWAY_REGISTRATION.REQUEST,
    { parseAs: 'buffer' },
    async (_req: any, rawBody: Buffer) => rawBody,
  );

  const privateKeyStore = initPrivateKeyStore((fastify as any).mongoose);

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

      const mongooseConnection = (fastify as any).mongoose;
      const config = new Config(mongooseConnection);
      const privateAddress = await config.get(ConfigKey.CURRENT_ID);
      const privateKey = await privateKeyStore.retrieveIdentityKey(privateAddress!!);

      const certificateStore = new MongoCertificateStore(mongooseConnection);
      const publicGatewayCertificationPath = await certificateStore.retrieveLatest(
        privateAddress!,
        privateAddress!,
      );
      const gatewayPublicKey = await publicGatewayCertificationPath!.leafCertificate.getPublicKey();

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
        privateKey!,
        publicGatewayCertificationPath!.leafCertificate,
      );
      const sessionKeyPair = await SessionKeyPair.generate();
      await privateKeyStore.saveSessionKey(
        sessionKeyPair.privateKey,
        sessionKeyPair.sessionKey.keyId,
        privateAddress!,
        await privateGatewayCertificate.calculateSubjectId(),
      );
      const registration = new PrivateNodeRegistration(
        privateGatewayCertificate,
        publicGatewayCertificationPath!.leafCertificate,
        sessionKeyPair.sessionKey,
      );
      return reply
        .code(200)
        .header('Content-Type', CONTENT_TYPES.GATEWAY_REGISTRATION.REGISTRATION)
        .send(Buffer.from(await registration.serialize()));
    },
  });
}
