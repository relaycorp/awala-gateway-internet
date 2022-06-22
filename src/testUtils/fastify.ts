import { FastifyInstance, HTTPMethods } from 'fastify';
import { Connection } from 'mongoose';

import { HTTP_METHODS } from '../services/fastify';

export function testDisallowedMethods(
  allowedMethods: readonly HTTPMethods[],
  endpointURL: string,
  initFastify: () => Promise<FastifyInstance>,
): void {
  const allowedMethodsString = allowedMethods.join(', ');

  const disallowedMethods = HTTP_METHODS.filter(
    (m) => !allowedMethods.includes(m) && m !== 'OPTIONS',
  );
  test.each(disallowedMethods)('%s requests should be refused', async (method) => {
    const fastify = await initFastify();

    const response = await fastify.inject({ method, url: endpointURL });

    expect(response).toHaveProperty('statusCode', 405);
    expect(response).toHaveProperty('headers.allow', allowedMethodsString);
  });

  test('OPTIONS requests should list the allowed methods', async () => {
    const fastify = await initFastify();

    const response = await fastify.inject({ method: 'OPTIONS', url: endpointURL });

    expect(response).toHaveProperty('statusCode', 204);
    expect(response).toHaveProperty('headers.allow', allowedMethodsString);
  });
}

export function mockFastifyMongoose(
  fastify: FastifyInstance,
  mockMongooseConnection: Connection,
): any {
  fastify.decorate('mongoose', mockMongooseConnection);
}
