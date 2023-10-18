import { type CloudEvent, HTTP } from 'cloudevents';
import type { FastifyInstance } from 'fastify';

export async function postEvent(
  event: CloudEvent<Buffer>,
  fastify: FastifyInstance,
): Promise<number> {
  const message = HTTP.binary(event);

  const response = await fastify.inject({
    method: 'POST',
    url: '/',
    headers: message.headers,
    payload: message.body as string,
  });
  return response.statusCode;
}
