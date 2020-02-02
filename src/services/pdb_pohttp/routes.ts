import { Parcel } from '@relaycorp/relaynet-core';
import { FastifyInstance, FastifyReply } from 'fastify';

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
      // tslint:disable-next-line:no-console
      console.log({ parcel });

      // const certs = await OwnCertificateModel.findAll();
      // // tslint:disable-next-line:no-console
      // console.log({ certs });

      // try {
      //   await queue.add(queueMessage);
      // } catch (error) {
      //   request.log.error('Failed to queue ping message', { err: error });
      //   return reply.code(500).send({ message: 'Could not queue ping message for processing' });
      // }
      return reply.code(202).send({});
    },
  });
}
