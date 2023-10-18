import type { CloudEventV1 } from 'cloudevents';
import { BaseLogger } from 'pino';
import { FastifyInstance } from 'fastify';

import { configureFastify, registerDisallowedMethods } from '../../utilities/fastify/server';
import { HTTP_STATUS_CODES } from '../../utilities/http';
import { Receiver } from '../../utilities/eventing/Receiver';
import pdcOutgoing from './sinks/pdcOutgoing';
import type { MessageSink, MessageSinkHandler } from './types';

const SINKS: MessageSink[] = [pdcOutgoing];
const HANDLER_BY_TYPE: { [contentType: string]: MessageSinkHandler } = SINKS.reduce(
  (acc, sink) => ({ ...acc, [sink.eventType]: sink.handler }),
  {},
);

async function makeQueueRoute(fastify: FastifyInstance): Promise<void> {
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, payload, next) => {
    next(null, payload);
  });

  registerDisallowedMethods(['POST'], '/', fastify);

  const eventReceiver = await Receiver.init();
  fastify.post('/', async (request, reply) => {
    let event: CloudEventV1<Buffer>;
    try {
      event = eventReceiver.convertMessageToEvent(request.headers, request.body as Buffer);
    } catch (err) {
      request.log.info('Refused malformed CloudEvent');
      return reply.status(HTTP_STATUS_CODES.ACCEPTED).send();
    }

    const handler = HANDLER_BY_TYPE[event.type];
    if (!handler) {
      request.log.info({ eventType: event.type }, 'Refused unsupported event type');
      return reply.status(HTTP_STATUS_CODES.ACCEPTED).send();
    }

    const wasFulfilled = await handler(event, { logger: request.log });
    const responseCode = wasFulfilled
      ? HTTP_STATUS_CODES.NO_CONTENT
      : HTTP_STATUS_CODES.SERVICE_UNAVAILABLE;
    return reply.code(responseCode).send();
  });
}

export default async function makeQueueServer(logger?: BaseLogger): Promise<FastifyInstance> {
  return configureFastify([makeQueueRoute], {}, logger);
}
