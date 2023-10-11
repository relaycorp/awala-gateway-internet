import { PrivateNodeRegistrationAuthorization } from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { testDisallowedMethods } from '../../testUtils/fastify';

import { makePoWebTestServer } from './_test_utils';
import { CONTENT_TYPES } from './contentTypes';
import { makeServer } from './server';

jest.mock('../../utilities/exitHandling');

const ENDPOINT_URL = '/v1/pre-registrations';

const getFixtures = makePoWebTestServer();

testDisallowedMethods(['POST'], ENDPOINT_URL, makeServer);

test('HTTP 415 should be returned if the request Content-Type is not text/plain', async () => {
  const fastify = await makeServer();

  const response = await fastify.inject({
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    payload: '{}',
    url: ENDPOINT_URL,
  });

  expect(response).toHaveProperty('statusCode', 415);
});

test.each([63, 65])(
  'HTTP 400 should be returned if the request body has %s octets',
  async (octetCount) => {
    const { server } = getFixtures();
    const requestBody = Buffer.from('a'.repeat(octetCount));

    const response = await server.inject({
      headers: { 'content-type': 'text/plain' },
      method: 'POST',
      payload: requestBody,
      url: ENDPOINT_URL,
    });

    expect(response).toHaveProperty('statusCode', 400);
    expect(response.headers['content-type']).toStartWith('application/json');
    expect(JSON.parse(response.payload)).toHaveProperty(
      'message',
      'Payload is not a SHA-256 digest',
    );
  },
);

test('A valid authorization should be issued if the request if valid', async () => {
  const { server } = getFixtures();
  const privateGatewayPublicKeyDigest = Buffer.from('a'.repeat(64), 'hex');

  const response = await server.inject({
    headers: { 'content-type': 'text/plain' },
    method: 'POST',
    payload: privateGatewayPublicKeyDigest.toString('hex'),
    url: ENDPOINT_URL,
  });

  expect(response).toHaveProperty('statusCode', 200);
  expect(response.headers['content-type']).toEqual(
    CONTENT_TYPES.GATEWAY_REGISTRATION.AUTHORIZATION,
  );

  const authorization = await PrivateNodeRegistrationAuthorization.deserialize(
    bufferToArray(response.rawPayload),
    await getFixtures().internetGatewayCert.getPublicKey(),
  );
  const now = new Date();
  expect(authorization.expiryDate.getTime()).toBeGreaterThan(now.getTime() + 8_000);
  expect(authorization.expiryDate.getTime()).toBeLessThanOrEqual(now.getTime() + 10_000);
  expect(privateGatewayPublicKeyDigest.equals(Buffer.from(authorization.gatewayData))).toBeTruthy();
});
