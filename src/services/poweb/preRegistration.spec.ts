// tslint:disable:no-let

import { PrivateNodeRegistrationAuthorization } from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { FastifyInstance, HTTPMethods } from 'fastify';

import { setUpCommonFixtures } from './_test_utils';
import { PNRA_CONTENT_TYPE } from './contentTypes';
import { makeServer } from './server';

const endpointURL = '/v1/pre-registrations';

const getFixtures = setUpCommonFixtures();

let fastify: FastifyInstance;
beforeEach(async () => (fastify = await makeServer()));

test.each(['HEAD', 'GET', 'PUT', 'PATCH', 'DELETE'] as readonly HTTPMethods[])(
  '%s requests should be refused',
  async (method) => {
    const response = await fastify.inject({
      method,
      url: endpointURL,
    });

    expect(response).toHaveProperty('statusCode', 405);
    expect(response).toHaveProperty('headers.allow', 'POST');
  },
);

test('HTTP 415 should be returned if the request Content-Type is not text/plain', async () => {
  const response = await fastify.inject({
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    payload: '{}',
    url: endpointURL,
  });

  expect(response).toHaveProperty('statusCode', 415);
});

test('HTTP 400 should be returned if the request body exceeds 32 octets', async () => {
  const requestBody = Buffer.from('a'.repeat(33));
  const response = await fastify.inject({
    headers: { 'content-type': 'text/plain' },
    method: 'POST',
    payload: requestBody,
    url: endpointURL,
  });

  expect(response).toHaveProperty('statusCode', 400);
  expect(response.headers['content-type']).toStartWith('application/json');
  expect(JSON.parse(response.payload)).toHaveProperty('message', 'Payload is not a SHA-256 digest');
});

test('A valid authorization should be issued if the request if valid', async () => {
  const requestBody = Buffer.from('a'.repeat(32));
  const response = await fastify.inject({
    headers: { 'content-type': 'text/plain' },
    method: 'POST',
    payload: requestBody,
    url: endpointURL,
  });

  expect(response).toHaveProperty('statusCode', 200);
  expect(response.headers['content-type']).toEqual(PNRA_CONTENT_TYPE);

  const authorization = await PrivateNodeRegistrationAuthorization.deserialize(
    bufferToArray(response.rawPayload),
    await getFixtures().publicGatewayCert.getPublicKey(),
  );
  const now = new Date();
  expect(authorization.expiryDate.getTime()).toBeGreaterThan(now.getTime() + 8_000);
  expect(authorization.expiryDate.getTime()).toBeLessThanOrEqual(now.getTime() + 10_000);
  expect(requestBody.equals(Buffer.from(authorization.gatewayData))).toBeTruthy();
});
