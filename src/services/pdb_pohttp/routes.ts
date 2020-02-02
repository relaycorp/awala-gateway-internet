import { Parcel } from '@relaycorp/relaynet-core';
import { mongoose } from '@typegoose/typegoose';
import { FastifyInstance, FastifyReply } from 'fastify';

import { retrieveOwnCertificates } from '../certs';
import { publishMessage } from '../nats';

export default async function registerRoutes(
  fastify: FastifyInstance,
  _options: any,
): Promise<void> {
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
        // tslint:disable-next-line:no-console
        console.log({
          attachedChain: await Promise.all(
            parcel.senderCaCertificateChain.map(c => c.calculateSubjectPrivateAddress()),
          ),
          certPath: await Promise.all(
            // @ts-ignore
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

      // @ts-ignore
      const certificatePath = await parcel.getSenderCertificationPath(trustedCertificates);
      const localGateway = certificatePath[0];
      const localGatewayAddress = await localGateway.calculateSubjectPrivateAddress();
      try {
        await publishMessage(request.body, `crc-parcel.${localGatewayAddress}`);
      } catch (error) {
        request.log.error({ err: error }, 'Failed to queue ping message');
        return reply
          .code(500)
          .send({ message: 'Parcel could not be stored; please try again later' });
      }
      return reply.code(202).send({});
    },
  });
}
