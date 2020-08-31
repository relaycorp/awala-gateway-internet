// tslint:disable:no-let

import {
  derSerializePublicKey,
  PrivateNodeRegistration,
  PrivateNodeRegistrationAuthorization,
  PrivateNodeRegistrationRequest,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { FastifyInstance, HTTPMethods } from 'fastify';

import { sha256 } from '../../_test_utils';
import { setUpCommonFixtures } from './_test_utils';
import { PNR_CONTENT_TYPE, PNRR_CONTENT_TYPE } from './contentTypes';
import { makeServer } from './server';

const ENDPOINT_URL = '/v1/nodes';

const getFixtures = setUpCommonFixtures();

let fastify: FastifyInstance;
beforeEach(async () => (fastify = await makeServer()));

test.each(['HEAD', 'GET', 'PUT', 'PATCH', 'DELETE'] as readonly HTTPMethods[])(
  '%s requests should be refused',
  async (method) => {
    const response = await fastify.inject({
      method,
      url: ENDPOINT_URL,
    });

    expect(response).toHaveProperty('statusCode', 405);
    expect(response).toHaveProperty('headers.allow', 'POST');
  },
);

test('HTTP 415 should be returned if the request Content-Type is not a PNRR', async () => {
  const response = await fastify.inject({
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    payload: '{}',
    url: ENDPOINT_URL,
  });

  expect(response).toHaveProperty('statusCode', 415);
});

test('HTTP 400 should be returned if the PNRR is not valid', async () => {
  const response = await fastify.inject({
    headers: { 'content-type': PNRR_CONTENT_TYPE },
    method: 'POST',
    payload: 'Not really a PNRA',
    url: ENDPOINT_URL,
  });

  expect(response).toHaveProperty('statusCode', 400);
  expect(JSON.parse(response.payload)).toHaveProperty(
    'message',
    'Payload is not a valid Private Node Registration Request',
  );
});

test('HTTP 400 should be returned if the authorization in the PNRR is invalid', async () => {
  const fixtures = getFixtures();
  const pnrr = new PrivateNodeRegistrationRequest(
    await fixtures.privateGatewayCert.getPublicKey(),
    bufferToArray(Buffer.from('invalid')),
  );
  const payload = await pnrr.serialize(fixtures.privateGatewayPrivateKey);

  const response = await fastify.inject({
    headers: { 'content-type': PNRR_CONTENT_TYPE },
    method: 'POST',
    payload: Buffer.from(payload),
    url: ENDPOINT_URL,
  });

  expect(response).toHaveProperty('statusCode', 400);
  expect(JSON.parse(response.payload)).toHaveProperty(
    'message',
    'Registration request contains an invalid authorization',
  );
});

test('HTTP 403 should be returned if PNRA is used with unauthorized key', async () => {
  const fixtures = getFixtures();
  const pnraSerialized = await generatePNRA(Buffer.from('Not really a public key'));
  const pnrr = new PrivateNodeRegistrationRequest(
    await fixtures.privateGatewayCert.getPublicKey(),
    pnraSerialized,
  );
  const payload = await pnrr.serialize(fixtures.privateGatewayPrivateKey);

  const response = await fastify.inject({
    headers: { 'content-type': PNRR_CONTENT_TYPE },
    method: 'POST',
    payload: Buffer.from(payload),
    url: ENDPOINT_URL,
  });

  expect(response).toHaveProperty('statusCode', 403);
  expect(JSON.parse(response.payload)).toHaveProperty(
    'message',
    'Registration authorization was granted to a different private gateway',
  );
});

test('HTTP 200 with the registration should be returned if the PNRA is valid', async () => {
  const fixtures = getFixtures();
  const privateGatewayPublicKey = await fixtures.privateGatewayCert.getPublicKey();
  const privateGatewayPublicKeySerialized = await derSerializePublicKey(privateGatewayPublicKey);
  const pnraSerialized = await generatePNRA(privateGatewayPublicKeySerialized);
  const pnrr = new PrivateNodeRegistrationRequest(privateGatewayPublicKey, pnraSerialized);
  const payload = await pnrr.serialize(fixtures.privateGatewayPrivateKey);

  const response = await fastify.inject({
    headers: { 'content-type': PNRR_CONTENT_TYPE },
    method: 'POST',
    payload: Buffer.from(payload),
    url: ENDPOINT_URL,
  });

  expect(response).toHaveProperty('statusCode', 200);
  expect(response.headers['content-type']).toEqual(PNR_CONTENT_TYPE);

  const registration = PrivateNodeRegistration.deserialize(bufferToArray(response.rawPayload));
  expect(registration.gatewayCertificate.isEqual(fixtures.publicGatewayCert)).toBeTrue();

  // Validate the private gateway's certificate
  const threeYearsInTheFuture = new Date();
  threeYearsInTheFuture.setFullYear(threeYearsInTheFuture.getFullYear() + 3);
  expect(registration.privateNodeCertificate.expiryDate.getTime()).toBeWithin(
    threeYearsInTheFuture.getTime() - 3_000,
    threeYearsInTheFuture.getTime(),
  );
  await expect(
    derSerializePublicKey(await registration.privateNodeCertificate.getPublicKey()),
  ).resolves.toEqual(privateGatewayPublicKeySerialized);
  await expect(
    registration.privateNodeCertificate.getCertificationPath([], [fixtures.publicGatewayCert]),
  ).resolves.toHaveLength(2);
});

async function generatePNRA(privateGatewayPublicKeySerialized: Buffer): Promise<ArrayBuffer> {
  const fixtures = getFixtures();
  const serverData = bufferToArray(sha256(privateGatewayPublicKeySerialized));
  const fiveSecondsInTheFuture = new Date();
  fiveSecondsInTheFuture.setSeconds(fiveSecondsInTheFuture.getSeconds() + 5);
  const authorization = new PrivateNodeRegistrationAuthorization(
    fiveSecondsInTheFuture,
    serverData,
  );
  return authorization.serialize(fixtures.publicGatewayPrivateKey);
}
