import { InvalidMessageError, Parcel, ParcelDeliverySigner } from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { FastifyInstance } from 'fastify';
import { Response as LightMyRequestResponse } from 'light-my-request';
import { Connection } from 'mongoose';

import * as certs from '../../pki';
import { testDisallowedMethods } from '../../testUtils/fastify';
import { getMockInstance, mockSpy } from '../../testUtils/jest';
import { partialPinoLog } from '../../testUtils/logging';
import { makePoWebTestServer } from './_test_utils';
import { CONTENT_TYPES } from './contentTypes';
import { makeServer } from './server';

jest.mock('../../utilities/exitHandling');

const ENDPOINT_URL = '/v1/parcels';

const getFixtures = makePoWebTestServer();

mockSpy(jest.spyOn(certs, 'retrieveOwnCertificates'), async () => {
  return [getFixtures().internetGatewayCert];
});

let PARCEL: Parcel;
let PARCEL_SERIALIZED: ArrayBuffer;
beforeEach(async () => {
  const fixtures = getFixtures();
  PARCEL = new Parcel(
    { id: await fixtures.peerEndpointCert.calculateSubjectId() },
    fixtures.pdaCert,
    Buffer.from([]),
  );
  PARCEL_SERIALIZED = await PARCEL.serialize(fixtures.pdaGranteePrivateKey);
});

describe('Disallowed methods', () => {
  testDisallowedMethods(['POST'], ENDPOINT_URL, makeServer);
});

test('Invalid request Content-Type should be refused with an HTTP 415 response', async () => {
  const { server } = getFixtures();

  const response = await postParcel(Buffer.from([]), server, undefined, 'text/plain');

  expect(response).toHaveProperty('statusCode', 415);
  expect(getFixtures().parcelStore.storeParcelFromPrivatePeer).not.toBeCalled();
});

describe('Authorization errors', () => {
  test('Requests without Authorization header should result in HTTP 401', async () => {
    const { server } = getFixtures();

    const response = await postParcel(Buffer.from([]), server);

    expectResponseToRequireAuthentication(response);
    expect(getFixtures().parcelStore.storeParcelFromPrivatePeer).not.toBeCalled();
  });

  test('Requests with the wrong Authorization type should result in HTTP 401', async () => {
    const { server } = getFixtures();

    const response = await postParcel(Buffer.from([]), server, 'Bearer 123');

    expectResponseToRequireAuthentication(response);
    expect(getFixtures().parcelStore.storeParcelFromPrivatePeer).not.toBeCalled();
  });

  test('Requests with missing Authorization value should result in HTTP 401', async () => {
    const { server } = getFixtures();

    const response = await postParcel(Buffer.from([]), server, 'Relaynet-Countersignature ');

    expectResponseToRequireAuthentication(response);
    expect(getFixtures().parcelStore.storeParcelFromPrivatePeer).not.toBeCalled();
  });

  test('Malformed base64-encoded countersignatures should result in HTTP 401', async () => {
    const { server } = getFixtures();

    const response = await postParcel(Buffer.from([]), server, 'Relaynet-Countersignature .');

    expectResponseToRequireAuthentication(response);
    expect(getFixtures().parcelStore.storeParcelFromPrivatePeer).not.toBeCalled();
  });

  test('Invalid parcel delivery countersignatures should result in HTTP 401', async () => {
    const { server, peerEndpointCert, privateGatewayPrivateKey, logs, parcelStore } = getFixtures();
    const signer = new ParcelDeliverySigner(
      peerEndpointCert, // Wrong certificate
      privateGatewayPrivateKey,
    );
    const countersignature = await signer.sign(PARCEL_SERIALIZED);

    const response = await postParcel(
      Buffer.from([]),
      server,
      makeAuthorizationHeaderValue(countersignature),
    );

    expectResponseToRequireAuthentication(response);
    expect(logs).toContainEqual(
      partialPinoLog('debug', 'Invalid countersignature', { err: expect.anything() }),
    );
    expect(parcelStore.storeParcelFromPrivatePeer).not.toBeCalled();
  });

  function expectResponseToRequireAuthentication(response: LightMyRequestResponse): void {
    expect(response).toHaveProperty('statusCode', 401);
    expect(response).toHaveProperty('headers.www-authenticate', 'Relaynet-Countersignature');
    expect(JSON.parse(response.payload)).toHaveProperty(
      'message',
      'Parcel delivery countersignature is either missing or invalid',
    );
  }
});

test('Malformed parcels should be refused with an HTTP 400 response', async () => {
  const { server } = getFixtures();
  const fixtures = getFixtures();
  const invalidParcelSerialization = Buffer.from('I am a "parcel". MUA HA HA HA!');
  const signer = new ParcelDeliverySigner(
    fixtures.privateGatewayCert,
    fixtures.privateGatewayPrivateKey,
  );
  const countersignature = await signer.sign(bufferToArray(invalidParcelSerialization));

  const response = await postParcel(
    invalidParcelSerialization,
    server,
    makeAuthorizationHeaderValue(countersignature),
  );

  expect(response).toHaveProperty('statusCode', 400);
  expect(JSON.parse(response.payload)).toHaveProperty('message', 'Parcel is malformed');
  expect(fixtures.parcelStore.storeParcelFromPrivatePeer).not.toBeCalled();
});

test('Well-formed yet invalid parcels should be refused with an HTTP 422 response', async () => {
  const { server, privateGatewayCert, privateGatewayPrivateKey, parcelStore, logs } = getFixtures();
  const signer = new ParcelDeliverySigner(privateGatewayCert, privateGatewayPrivateKey);
  const countersignature = await signer.sign(PARCEL_SERIALIZED);
  const error = new InvalidMessageError('Whoops');
  getMockInstance(parcelStore.storeParcelFromPrivatePeer).mockRejectedValue(error);

  const response = await postParcel(
    PARCEL_SERIALIZED,
    server,
    makeAuthorizationHeaderValue(countersignature),
  );

  expect(response).toHaveProperty('statusCode', 422);
  expect(JSON.parse(response.payload)).toHaveProperty('message', 'Parcel is invalid');
  expect(logs).toContainEqual(
    partialPinoLog('info', 'Invalid parcel', {
      err: expect.objectContaining({ message: error.message }),
      privatePeerId: await privateGatewayCert.calculateSubjectId(),
    }),
  );
});

test('Valid parcels should result in an HTTP 202 response', async () => {
  const {
    server,
    privateGatewayCert,
    privateGatewayPrivateKey,
    parcelStore,
    logs,
    redisPubSubClient,
  } = getFixtures();
  const signer = new ParcelDeliverySigner(privateGatewayCert, privateGatewayPrivateKey);
  const countersignature = await signer.sign(PARCEL_SERIALIZED);

  const response = await postParcel(
    PARCEL_SERIALIZED,
    server,
    makeAuthorizationHeaderValue(countersignature),
  );

  expect(response).toHaveProperty('statusCode', 202);
  expect(parcelStore.storeParcelFromPrivatePeer).toBeCalledWith(
    expect.objectContaining({ id: PARCEL.id }),
    Buffer.from(PARCEL_SERIALIZED),
    await privateGatewayCert.calculateSubjectId(),
    expect.any(Connection),
    getFixtures().emitter,
    redisPubSubClient.publishers[0].publish,
    expect.anything(),
  );
  expect(logs).toContainEqual(
    partialPinoLog('info', 'Parcel was successfully stored', {
      parcelId: PARCEL.id,
      privatePeerId: await privateGatewayCert.calculateSubjectId(),
    }),
  );
});

test('Previously-processed parcels should be logged as such', async () => {
  const { server, privateGatewayCert, privateGatewayPrivateKey, parcelStore, logs } = getFixtures();
  getMockInstance(parcelStore.storeParcelFromPrivatePeer).mockResolvedValue(false);
  const signer = new ParcelDeliverySigner(privateGatewayCert, privateGatewayPrivateKey);
  const countersignature = await signer.sign(PARCEL_SERIALIZED);

  await postParcel(PARCEL_SERIALIZED, server, makeAuthorizationHeaderValue(countersignature));

  expect(logs).toContainEqual(
    partialPinoLog('info', 'Parcel was previously stored', {
      parcelId: PARCEL.id,
      privatePeerId: await privateGatewayCert.calculateSubjectId(),
    }),
  );
});

test('Failing to save a valid parcel should result in an HTTP 500 response', async () => {
  const { server, logs, privateGatewayPrivateKey, privateGatewayCert, parcelStore } = getFixtures();
  const signer = new ParcelDeliverySigner(privateGatewayCert, privateGatewayPrivateKey);
  const countersignature = await signer.sign(PARCEL_SERIALIZED);
  const error = new Error('Whoops');
  getMockInstance(parcelStore.storeParcelFromPrivatePeer).mockRejectedValue(error);

  const response = await postParcel(
    PARCEL_SERIALIZED,
    server,
    makeAuthorizationHeaderValue(countersignature),
  );

  expect(response).toHaveProperty('statusCode', 500);
  expect(JSON.parse(response.payload)).toHaveProperty(
    'message',
    'Could not save parcel. Please try again later.',
  );
  expect(logs).toContainEqual(
    partialPinoLog('error', 'Failed to save parcel', {
      err: expect.objectContaining({ message: error.message }),
      privatePeerId: await privateGatewayCert.calculateSubjectId(),
    }),
  );
});

test('Redis connection should be closed when server ends', async () => {
  const { server, redisPubSubClient } = getFixtures();
  const publisher = redisPubSubClient.publishers[0];
  expect(publisher.close).not.toBeCalled();

  await server.close();

  expect(publisher.close).toBeCalled();
});

async function postParcel(
  parcelSerialized: Buffer | ArrayBuffer,
  server: FastifyInstance,
  authorizationHeaderValue?: string,
  contentType = CONTENT_TYPES.PARCEL,
): Promise<LightMyRequestResponse> {
  return server.inject({
    headers: {
      'content-type': contentType,
      ...(authorizationHeaderValue && { authorization: authorizationHeaderValue }),
    },
    method: 'POST',
    payload: Buffer.from(parcelSerialized),
    url: ENDPOINT_URL,
  });
}

function makeAuthorizationHeaderValue(countersignature: ArrayBuffer): string {
  const countersignatureBase64 = Buffer.from(countersignature).toString('base64');
  return `Relaynet-Countersignature ${countersignatureBase64}`;
}
