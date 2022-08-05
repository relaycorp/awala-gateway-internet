import { InvalidMessageError, Parcel, ParcelDeliverySigner } from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { FastifyInstance } from 'fastify';
import LightMyRequest, { Response as LightMyRequestResponse } from 'light-my-request';

import { NatsStreamingClient } from '../../backingServices/natsStreaming';
import * as certs from '../../pki';
import { testDisallowedMethods } from '../../testUtils/fastify';
import { getMockInstance, mockSpy } from '../../testUtils/jest';
import { makeMockLogging, partialPinoLog } from '../../testUtils/logging';
import { setUpCommonFixtures } from './_test_utils';
import { CONTENT_TYPES } from './contentTypes';
import { makeServer } from './server';

jest.mock('../../utilities/exitHandling');

const ENDPOINT_URL = '/v1/parcels';

const getFixtures = setUpCommonFixtures();

const mockNatsStreamingConnection: NatsStreamingClient = {} as any;
const mockNatsStreamingInit = mockSpy(
  jest.spyOn(NatsStreamingClient, 'initFromEnv'),
  () => mockNatsStreamingConnection,
);

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
  const fastify = await makeServer();

  const response = await postParcel(Buffer.from([]), fastify, undefined, 'text/plain');

  expect(response).toHaveProperty('statusCode', 415);
  expect(getFixtures().parcelStore.storeParcelFromPrivatePeer).not.toBeCalled();
});

describe('Authorization errors', () => {
  test('Requests without Authorization header should result in HTTP 401', async () => {
    const fastify = await makeServer();

    const response = await postParcel(Buffer.from([]), fastify);

    expectResponseToRequireAuthentication(response);
    expect(getFixtures().parcelStore.storeParcelFromPrivatePeer).not.toBeCalled();
  });

  test('Requests with the wrong Authorization type should result in HTTP 401', async () => {
    const fastify = await makeServer();

    const response = await postParcel(Buffer.from([]), fastify, 'Bearer 123');

    expectResponseToRequireAuthentication(response);
    expect(getFixtures().parcelStore.storeParcelFromPrivatePeer).not.toBeCalled();
  });

  test('Requests with missing Authorization value should result in HTTP 401', async () => {
    const fastify = await makeServer();

    const response = await postParcel(Buffer.from([]), fastify, 'Relaynet-Countersignature ');

    expectResponseToRequireAuthentication(response);
    expect(getFixtures().parcelStore.storeParcelFromPrivatePeer).not.toBeCalled();
  });

  test('Malformed base64-encoded countersignatures should result in HTTP 401', async () => {
    const fastify = await makeServer();

    const response = await postParcel(Buffer.from([]), fastify, 'Relaynet-Countersignature .');

    expectResponseToRequireAuthentication(response);
    expect(getFixtures().parcelStore.storeParcelFromPrivatePeer).not.toBeCalled();
  });

  test('Invalid parcel delivery countersignatures should result in HTTP 401', async () => {
    const logging = makeMockLogging();
    const fastify = await makeServer(logging.logger);
    const fixtures = getFixtures();
    const signer = new ParcelDeliverySigner(
      fixtures.peerEndpointCert, // Wrong certificate
      fixtures.privateGatewayPrivateKey,
    );
    const countersignature = await signer.sign(PARCEL_SERIALIZED);

    const response = await postParcel(
      Buffer.from([]),
      fastify,
      makeAuthorizationHeaderValue(countersignature),
    );

    expectResponseToRequireAuthentication(response);
    expect(logging.logs).toContainEqual(
      partialPinoLog('debug', 'Invalid countersignature', { err: expect.anything() }),
    );
    expect(fixtures.parcelStore.storeParcelFromPrivatePeer).not.toBeCalled();
  });

  function expectResponseToRequireAuthentication(response: LightMyRequest.Response): void {
    expect(response).toHaveProperty('statusCode', 401);
    expect(response).toHaveProperty('headers.www-authenticate', 'Relaynet-Countersignature');
    expect(JSON.parse(response.payload)).toHaveProperty(
      'message',
      'Parcel delivery countersignature is either missing or invalid',
    );
  }
});

test('Malformed parcels should be refused with an HTTP 400 response', async () => {
  const fastify = await makeServer();
  const fixtures = getFixtures();
  const invalidParcelSerialization = Buffer.from('I am a "parcel". MUA HA HA HA!');
  const signer = new ParcelDeliverySigner(
    fixtures.privateGatewayCert,
    fixtures.privateGatewayPrivateKey,
  );
  const countersignature = await signer.sign(bufferToArray(invalidParcelSerialization));

  const response = await postParcel(
    invalidParcelSerialization,
    fastify,
    makeAuthorizationHeaderValue(countersignature),
  );

  expect(response).toHaveProperty('statusCode', 400);
  expect(JSON.parse(response.payload)).toHaveProperty('message', 'Parcel is malformed');
  expect(fixtures.parcelStore.storeParcelFromPrivatePeer).not.toBeCalled();
});

test('Well-formed yet invalid parcels should be refused with an HTTP 422 response', async () => {
  const logging = makeMockLogging();
  const fastify = await makeServer(logging.logger);
  const fixtures = getFixtures();
  const signer = new ParcelDeliverySigner(
    fixtures.privateGatewayCert,
    fixtures.privateGatewayPrivateKey,
  );
  const countersignature = await signer.sign(PARCEL_SERIALIZED);
  const error = new InvalidMessageError('Whoops');
  getMockInstance(fixtures.parcelStore.storeParcelFromPrivatePeer).mockRejectedValue(error);

  const response = await postParcel(
    PARCEL_SERIALIZED,
    fastify,
    makeAuthorizationHeaderValue(countersignature),
  );

  expect(response).toHaveProperty('statusCode', 422);
  expect(JSON.parse(response.payload)).toHaveProperty('message', 'Parcel is invalid');
  expect(logging.logs).toContainEqual(
    partialPinoLog('info', 'Invalid parcel', {
      err: expect.objectContaining({ message: error.message }),
      privatePeerId: await fixtures.privateGatewayCert.calculateSubjectId(),
    }),
  );
});

test('Valid parcels should result in an HTTP 202 response', async () => {
  const logging = makeMockLogging();
  const fastify = await makeServer(logging.logger);
  const fixtures = getFixtures();
  const signer = new ParcelDeliverySigner(
    fixtures.privateGatewayCert,
    fixtures.privateGatewayPrivateKey,
  );
  const countersignature = await signer.sign(PARCEL_SERIALIZED);

  const response = await postParcel(
    PARCEL_SERIALIZED,
    fastify,
    makeAuthorizationHeaderValue(countersignature),
  );

  expect(response).toHaveProperty('statusCode', 202);
  expect(fixtures.parcelStore.storeParcelFromPrivatePeer).toBeCalledWith(
    expect.objectContaining({ id: PARCEL.id }),
    Buffer.from(PARCEL_SERIALIZED),
    await fixtures.privateGatewayCert.calculateSubjectId(),
    fixtures.getMongooseConnection(),
    mockNatsStreamingConnection,
    expect.objectContaining({ debug: expect.toBeFunction(), info: expect.toBeFunction() }),
  );
  expect(logging.logs).toContainEqual(
    partialPinoLog('debug', 'Parcel is well-formed', {
      parcelId: PARCEL.id,
      privatePeerId: await fixtures.privateGatewayCert.calculateSubjectId(),
    }),
  );
  expect(logging.logs).toContainEqual(
    partialPinoLog('info', 'Parcel was successfully stored', {
      parcelId: PARCEL.id,
      parcelObjectKey: expect.stringContaining(PARCEL.id),
      privatePeerId: await fixtures.privateGatewayCert.calculateSubjectId(),
    }),
  );
});

test('Failing to save a valid parcel should result in an HTTP 500 response', async () => {
  const logging = makeMockLogging();
  const fastify = await makeServer(logging.logger);
  const fixtures = getFixtures();
  const signer = new ParcelDeliverySigner(
    fixtures.privateGatewayCert,
    fixtures.privateGatewayPrivateKey,
  );
  const countersignature = await signer.sign(PARCEL_SERIALIZED);
  const error = new Error('Whoops');
  getMockInstance(fixtures.parcelStore.storeParcelFromPrivatePeer).mockRejectedValue(error);

  const response = await postParcel(
    PARCEL_SERIALIZED,
    fastify,
    makeAuthorizationHeaderValue(countersignature),
  );

  expect(response).toHaveProperty('statusCode', 500);
  expect(JSON.parse(response.payload)).toHaveProperty(
    'message',
    'Could not save parcel. Please try again later.',
  );
  expect(logging.logs).toContainEqual(
    partialPinoLog('error', 'Failed to save parcel', {
      err: expect.objectContaining({ message: error.message }),
      privatePeerId: await fixtures.privateGatewayCert.calculateSubjectId(),
    }),
  );
});

test('NATS Streaming connection should use the right arguments', async () => {
  const fastify = await makeServer();
  const fixtures = getFixtures();
  const signer = new ParcelDeliverySigner(
    fixtures.privateGatewayCert,
    fixtures.privateGatewayPrivateKey,
  );
  const countersignature = await signer.sign(PARCEL_SERIALIZED);

  await postParcel(PARCEL_SERIALIZED, fastify, makeAuthorizationHeaderValue(countersignature));

  expect(mockNatsStreamingInit).toBeCalledWith(
    expect.stringMatching(/^poweb-parcel-delivery-req-\d+$/),
  );
});

async function postParcel(
  parcelSerialized: Buffer | ArrayBuffer,
  fastify: FastifyInstance,
  authorizationHeaderValue?: string,
  contentType = CONTENT_TYPES.PARCEL,
): Promise<LightMyRequestResponse> {
  return fastify.inject({
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
