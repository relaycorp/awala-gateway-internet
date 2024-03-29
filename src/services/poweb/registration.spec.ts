import {
  derSerializePublicKey,
  InvalidMessageError,
  PrivateNodeRegistration,
  PrivateNodeRegistrationAuthorization,
  PrivateNodeRegistrationRequest,
  SessionPrivateKeyData,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { addDays } from 'date-fns';
import { FastifyInstance } from 'fastify';
import { Response } from 'light-my-request';
import { GATEWAY_INTERNET_ADDRESS } from '../../testUtils/awala';

import { arrayBufferFrom } from '../../testUtils/buffers';
import { sha256 } from '../../testUtils/crypto';
import { testDisallowedMethods } from '../../testUtils/fastify';
import { MockLogSet, partialPinoLog } from '../../testUtils/logging';
import { PoWebFixtureSet, makePoWebTestServer } from './_test_utils';
import { CONTENT_TYPES } from './contentTypes';
import { makeServer } from './server';

jest.mock('../../utilities/exitHandling');

const ENDPOINT_URL = '/v1/nodes';

const getFixtures = makePoWebTestServer();

let server: FastifyInstance;
let logs: MockLogSet;
beforeEach(() => {
  ({ server, logs } = getFixtures());
});

testDisallowedMethods(['POST'], ENDPOINT_URL, makeServer);

test('HTTP 415 should be returned if the request Content-Type is not a PNRR', async () => {
  const response = await server.inject({
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    payload: '{}',
    url: ENDPOINT_URL,
  });

  expect(response).toHaveProperty('statusCode', 415);
});

test('HTTP 400 should be returned if the PNRR is not valid', async () => {
  const response = await server.inject({
    headers: { 'content-type': CONTENT_TYPES.GATEWAY_REGISTRATION.REQUEST },
    method: 'POST',
    payload: 'Not really a PNRA',
    url: ENDPOINT_URL,
  });

  expect(response).toHaveProperty('statusCode', 400);
  expect(JSON.parse(response.payload)).toHaveProperty(
    'message',
    'Payload is not a valid Private Node Registration Request',
  );
  expect(logs).toContainEqual(
    partialPinoLog('info', 'Invalid PNRR received', {
      err: expect.objectContaining({ type: InvalidMessageError.name }),
    }),
  );
});

test('HTTP 400 should be returned if the authorization in the PNRR is invalid', async () => {
  const fixtures = getFixtures();
  const pnrr = new PrivateNodeRegistrationRequest(
    await fixtures.privateGatewayCert.getPublicKey(),
    arrayBufferFrom('invalid'),
  );
  const payload = await pnrr.serialize(fixtures.privateGatewayPrivateKey);

  const response = await server.inject({
    headers: { 'content-type': CONTENT_TYPES.GATEWAY_REGISTRATION.REQUEST },
    method: 'POST',
    payload: Buffer.from(payload),
    url: ENDPOINT_URL,
  });

  expect(response).toHaveProperty('statusCode', 400);
  expect(JSON.parse(response.payload)).toHaveProperty(
    'message',
    'Registration request contains an invalid authorization',
  );
  expect(logs).toContainEqual(
    partialPinoLog('info', 'PNRR contains invalid authorization', {
      err: expect.objectContaining({ type: InvalidMessageError.name }),
    }),
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

  const response = await server.inject({
    headers: { 'content-type': CONTENT_TYPES.GATEWAY_REGISTRATION.REQUEST },
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

describe('Successful registration', () => {
  test('HTTP 200 with the registration should be returned', async () => {
    const fixtures = getFixtures();

    const response = await completeRegistration(fixtures);

    expect(response).toHaveProperty('statusCode', 200);
    expect(response.headers['content-type']).toEqual(
      CONTENT_TYPES.GATEWAY_REGISTRATION.REGISTRATION,
    );

    const registration = await PrivateNodeRegistration.deserialize(
      bufferToArray(response.rawPayload),
    );
    expect(registration.gatewayCertificate.isEqual(fixtures.internetGatewayCert)).toBeTrue();
  });

  test('Private gateway certificate should be issued by Internet gateway', async () => {
    const fixtures = getFixtures();

    const response = await completeRegistration(fixtures);

    const registration = await PrivateNodeRegistration.deserialize(
      bufferToArray(response.rawPayload),
    );
    expect(registration.gatewayCertificate.isEqual(fixtures.internetGatewayCert)).toBeTrue();
    await expect(
      registration.privateNodeCertificate.getCertificationPath([], [fixtures.internetGatewayCert]),
    ).resolves.toHaveLength(2);
  });

  test('Private gateway certificate should be valid starting 3 hours in the past', async () => {
    const fixtures = getFixtures();

    const response = await completeRegistration(fixtures);

    const registration = await PrivateNodeRegistration.deserialize(
      bufferToArray(response.rawPayload),
    );
    const threeHoursInThePast = new Date();
    threeHoursInThePast.setHours(threeHoursInThePast.getHours() - 3);
    expect(registration.privateNodeCertificate.startDate.getTime()).toBeWithin(
      threeHoursInThePast.getTime() - 3_000,
      threeHoursInThePast.getTime(),
    );
  });

  test('Private gateway certificate should be valid for 180 days', async () => {
    const fixtures = getFixtures();

    const response = await completeRegistration(fixtures);

    const registration = await PrivateNodeRegistration.deserialize(
      bufferToArray(response.rawPayload),
    );
    const expectedExpiryDate = addDays(new Date(), 180);
    expect(registration.privateNodeCertificate.expiryDate.getTime()).toBeWithin(
      expectedExpiryDate.getTime() - 3_000,
      expectedExpiryDate.getTime(),
    );
  });

  test('Private gateway certificate should honor subject public key', async () => {
    const fixtures = getFixtures();

    const response = await completeRegistration(fixtures);

    const registration = await PrivateNodeRegistration.deserialize(
      bufferToArray(response.rawPayload),
    );
    expect(registration.gatewayCertificate.isEqual(fixtures.internetGatewayCert)).toBeTrue();

    const privateGatewayPublicKey = await fixtures.privateGatewayCert.getPublicKey();
    const privateGatewayPublicKeySerialized = await derSerializePublicKey(privateGatewayPublicKey);
    await expect(
      derSerializePublicKey(await registration.privateNodeCertificate.getPublicKey()),
    ).resolves.toEqual(privateGatewayPublicKeySerialized);
  });

  test('Internet address should be included in registration', async () => {
    const fixtures = getFixtures();

    const response = await completeRegistration(fixtures);

    const registration = await PrivateNodeRegistration.deserialize(
      bufferToArray(response.rawPayload),
    );
    expect(registration.internetGatewayInternetAddress).toEqual(GATEWAY_INTERNET_ADDRESS);
  });

  test('Session key should be included in registration', async () => {
    const fixtures = getFixtures();

    const response = await completeRegistration(fixtures);

    const registration = await PrivateNodeRegistration.deserialize(
      bufferToArray(response.rawPayload),
    );
    expect(registration.sessionKey).toBeTruthy();
  });

  test('Session key should be bound to private gateway', async () => {
    const fixtures = getFixtures();

    const response = await completeRegistration(fixtures);

    const registration = await PrivateNodeRegistration.deserialize(
      bufferToArray(response.rawPayload),
    );
    const keyData =
      fixtures.privateKeyStore.sessionKeys[registration.sessionKey!!.keyId.toString('hex')];
    expect(keyData).toMatchObject<Partial<SessionPrivateKeyData>>({
      peerId: await fixtures.privateGatewayCert.calculateSubjectId(),
    });
  });

  async function completeRegistration(fixtures: PoWebFixtureSet): Promise<Response> {
    const privateGatewayPublicKey = await fixtures.privateGatewayCert.getPublicKey();
    const pnraSerialized = await generatePNRA(await derSerializePublicKey(privateGatewayPublicKey));
    const pnrr = new PrivateNodeRegistrationRequest(privateGatewayPublicKey, pnraSerialized);
    const payload = await pnrr.serialize(fixtures.privateGatewayPrivateKey);

    return server.inject({
      headers: { 'content-type': CONTENT_TYPES.GATEWAY_REGISTRATION.REQUEST },
      method: 'POST',
      payload: Buffer.from(payload),
      url: ENDPOINT_URL,
    });
  }
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
  return authorization.serialize(fixtures.internetGatewayPrivateKey);
}
