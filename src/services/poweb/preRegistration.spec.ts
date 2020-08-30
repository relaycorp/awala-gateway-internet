// tslint:disable:no-let

import {
  Certificate,
  MockPrivateKeyStore,
  PrivateNodeRegistrationAuthorization,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { EnvVarError } from 'env-var';
import { FastifyInstance, HTTPMethods } from 'fastify';
import fastifyPlugin from 'fastify-plugin';

import { mockSpy } from '../../_test_utils';
import * as privateKeyStore from '../../backingServices/privateKeyStore';
import { configureMockEnvVars, generatePdaChain } from '../_test_utils';
import { makeServer } from './server';

const endpointURL = '/v1/pre-registrations';

jest.mock('fastify-mongoose', () => {
  function mockFunc(_fastify: FastifyInstance, _options: any, next: () => void): void {
    next();
  }
  return fastifyPlugin(mockFunc, { name: 'fastify-mongoose' });
});

let gatewayPrivateKey: CryptoKey;
let gatewayPublicKey: CryptoKey;
let gatewayCertificate: Certificate;
beforeAll(async () => {
  const chain = await generatePdaChain();
  gatewayPrivateKey = chain.privateGatewayPrivateKey;
  gatewayCertificate = chain.privateGatewayCert;
  gatewayPublicKey = await gatewayCertificate.getPublicKey();
});

let mockPrivateKeyStore: MockPrivateKeyStore;
beforeEach(async () => {
  mockPrivateKeyStore = new MockPrivateKeyStore();
  await mockPrivateKeyStore.registerNodeKey(gatewayPrivateKey, gatewayCertificate);
});
mockSpy(jest.spyOn(privateKeyStore, 'initVaultKeyStore'), () => mockPrivateKeyStore);

const BASE_ENV_VARS = { MONGO_URI: 'mongodb://example.com' };
const mockEnvVars = configureMockEnvVars(BASE_ENV_VARS);
beforeEach(() => {
  mockEnvVars({
    ...BASE_ENV_VARS,
    GATEWAY_KEY_ID: gatewayCertificate.getSerialNumber().toString('base64'),
  });
});

let fastify: FastifyInstance;
beforeEach(async () => (fastify = await makeServer()));

test('Environment variable GATEWAY_KEY_ID should be present', async () => {
  mockEnvVars({ ...BASE_ENV_VARS, GATEWAY_KEY_ID: undefined });

  await expect(makeServer()).rejects.toBeInstanceOf(EnvVarError);
});

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
  expect(response.headers['content-type']).toEqual(
    'application/vnd.relaynet.node-registration.authorization',
  );

  const authorization = await PrivateNodeRegistrationAuthorization.deserialize(
    bufferToArray(response.rawPayload),
    gatewayPublicKey,
  );
  const now = new Date();
  expect(authorization.expiryDate.getTime()).toBeGreaterThan(now.getTime() + 8_000);
  expect(authorization.expiryDate.getTime()).toBeLessThanOrEqual(now.getTime() + 10_000);
  expect(requestBody.equals(Buffer.from(authorization.gatewayData))).toBeTruthy();
});
