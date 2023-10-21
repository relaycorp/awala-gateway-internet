import type { CloudEventV1 } from 'cloudevents';
import { BaseLogger } from 'pino';
import { FastifyInstance } from 'fastify';

import { configureFastify, registerDisallowedMethods } from '../../utilities/fastify/server';
import { HTTP_STATUS_CODES } from '../../utilities/http';
import { QueueReceiver } from '../../utilities/backgroundQueue/QueueReceiver';
import type { MessageSink, MessageSinkHandler } from './types';
import pdcOutgoing from './sinks/pdcOutgoing';
import crcIncoming from './sinks/crcIncoming';
import { InternetGatewayManager } from '../../node/InternetGatewayManager';
import { RedisPubSubClient } from '../../backingServices/RedisPubSubClient';
import { QueueEmitter } from '../../utilities/backgroundQueue/QueueEmitter';
import { ParcelStore } from '../../parcelStore';

const SINKS: MessageSink[] = [pdcOutgoing, crcIncoming];
const HANDLER_BY_TYPE: { [contentType: string]: MessageSinkHandler } = SINKS.reduce(
  (acc, sink) => ({ ...acc, [sink.eventType]: sink.handler }),
  {},
);

async function makeQueueRoute(fastify: FastifyInstance): Promise<void> {
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, payload, next) => {
    next(null, payload);
  });

  registerDisallowedMethods(['GET', 'HEAD', 'POST'], '/', fastify);

  fastify.route({
    method: ['HEAD', 'GET'],
    url: '/',
    async handler(_req, reply): Promise<void> {
      reply
        .code(200)
        .header('Content-Type', 'text/plain')
        .send('Success! The background queue works.');
    },
  });

  const gatewayManager = await InternetGatewayManager.init(fastify.mongoose);
  const parcelStore = ParcelStore.initFromEnv();
  const queueReceiver = await QueueReceiver.init();
  const queueEmitter = await QueueEmitter.init();

  const redisPublisher = await RedisPubSubClient.init().makePublisher();
  fastify.addHook('onClose', async () => redisPublisher.close());

  fastify.post('/', async (request, reply) => {
    let event: CloudEventV1<Buffer>;
    try {
      event = queueReceiver.convertMessageToEvent(request.headers, request.body as Buffer);
    } catch (err) {
      request.log.info('Refused malformed CloudEvent');
      return reply.status(HTTP_STATUS_CODES.ACCEPTED).send();
    }

    const handler = HANDLER_BY_TYPE[event.type];
    if (!handler) {
      request.log.info({ eventType: event.type }, 'Refused unsupported event type');
      return reply.status(HTTP_STATUS_CODES.ACCEPTED).send();
    }

    const wasFulfilled = await handler(event, {
      logger: request.log,
      gatewayManager,
      redisPublish: redisPublisher.publish,
      dbConnection: fastify.mongoose,
      parcelStore,
      queueEmitter,
    });
    const responseCode = wasFulfilled
      ? HTTP_STATUS_CODES.NO_CONTENT
      : HTTP_STATUS_CODES.SERVICE_UNAVAILABLE;
    return reply.code(responseCode).send();
  });
}

export default async function makeQueueServer(logger?: BaseLogger): Promise<FastifyInstance> {
  return configureFastify([makeQueueRoute], {}, logger);
}
