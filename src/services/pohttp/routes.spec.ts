import { InvalidMessageError, Parcel } from '@relaycorp/relaynet-core';
import { FastifyInstance } from 'fastify';
import { InjectOptions } from 'light-my-request';

import { NatsStreamingClient } from '../../backingServices/natsStreaming';
import { ParcelStore } from '../../parcelStore';
import { MONGO_ENV_VARS } from '../../testUtils/db';
import { getMockInstance, mockSpy } from '../../testUtils/jest';
import { generatePdaChain, PdaChain } from '../../testUtils/pki';
import {
  configureMockEnvVars,
  generateStubParcel,
  mockFastifyMongoose,
  testDisallowedMethods,
} from '../_test_utils';
import { makeServer } from './server';

jest.mock('../../utilities/exitHandling');

const mockFastifyMongooseObject = { db: { what: 'The mongoose.Connection' } as any, ObjectId: {} };
mockFastifyMongoose(() => mockFastifyMongooseObject);

const validRequestOptions: InjectOptions = {
  headers: {
    'Content-Type': 'application/vnd.awala.parcel',
    Host: 'gw.relaycorp.tech:8000',
  },
  method: 'POST',
  url: '/',
};
let stubPdaChain: PdaChain;

let PARCEL: Parcel;
beforeAll(async () => {
  stubPdaChain = await generatePdaChain();

  PARCEL = await generateStubParcel({
    recipientAddress: await stubPdaChain.peerEndpointCert.calculateSubjectPrivateAddress(),
    senderCertificate: stubPdaChain.pdaCert,
    senderCertificateChain: [stubPdaChain.peerEndpointCert, stubPdaChain.privateGatewayCert],
  });
  const payload = Buffer.from(await PARCEL.serialize(stubPdaChain.pdaGranteePrivateKey));
  // tslint:disable-next-line:no-object-mutation
  validRequestOptions.payload = payload;
  // tslint:disable-next-line:readonly-keyword no-object-mutation
  (validRequestOptions.headers as { [key: string]: string })['Content-Length'] =
    payload.byteLength.toString();
});

const STUB_NATS_SERVER_URL = 'nats://example.com';
const STUB_NATS_CLUSTER_ID = 'nats-cluster-id';
const mockNatsClient: NatsStreamingClient = {
  what: 'The NATS Streaming client',
} as any;
const mockNatsClientInit = mockSpy(
  jest.spyOn(NatsStreamingClient, 'initFromEnv'),
  () => mockNatsClient,
);

const mockParcelStore: ParcelStore = {
  storeGatewayBoundParcel: mockSpy(jest.fn(), async () => undefined),
} as any;
jest.spyOn(ParcelStore, 'initFromEnv').mockReturnValue(mockParcelStore);

describe('receiveParcel', () => {
  configureMockEnvVars({
    ...MONGO_ENV_VARS,
    GATEWAY_VERSION: '1.0.2',
    NATS_CLUSTER_ID: STUB_NATS_CLUSTER_ID,
    NATS_SERVER_URL: STUB_NATS_SERVER_URL,
  });

  let serverInstance: FastifyInstance;
  beforeAll(async () => {
    serverInstance = await makeServer();
  });

  testDisallowedMethods(['HEAD', 'GET', 'POST'], '/', makeServer);

  test('A plain simple HEAD request should provide some diagnostic information', async () => {
    const response = await serverInstance.inject({ method: 'HEAD', url: '/' });

    expect(response).toHaveProperty('statusCode', 200);
    expect(response).toHaveProperty('headers.content-type', 'text/plain');
  });

  test('A plain simple GET request should provide some diagnostic information', async () => {
    const response = await serverInstance.inject({ method: 'GET', url: '/' });

    expect(response).toHaveProperty('statusCode', 200);
    expect(response).toHaveProperty('headers.content-type', 'text/plain');
    expect(response.payload).toContain('Success');
    expect(response.payload).toContain('PoHTTP');
  });

  test('Content-Type other than application/vnd.awala.parcel should be refused', async () => {
    const response = await serverInstance.inject({
      ...validRequestOptions,
      headers: {
        ...validRequestOptions.headers,
        'Content-Length': '2',
        'Content-Type': 'application/json',
      },
      payload: {},
    });

    expect(response).toHaveProperty('statusCode', 415);
  });

  test('Request body should be refused if it is not a valid RAMF-serialized parcel', async () => {
    const payload = Buffer.from('');
    const response = await serverInstance.inject({
      ...validRequestOptions,
      headers: { ...validRequestOptions.headers, 'Content-Length': payload.byteLength.toString() },
      payload,
    });

    expect(response).toHaveProperty('statusCode', 400);
    expect(JSON.parse(response.payload)).toHaveProperty(
      'message',
      'Payload is not a valid RAMF-serialized parcel',
    );
  });

  test('Parcel should be refused if recipient address is not private', async () => {
    const parcel = await generateStubParcel({
      recipientAddress: 'https://public.address/',
      senderCertificate: stubPdaChain.pdaCert,
    });
    const payload = Buffer.from(await parcel.serialize(stubPdaChain.pdaGranteePrivateKey));
    const response = await serverInstance.inject({
      ...validRequestOptions,
      headers: { ...validRequestOptions.headers, 'Content-Length': payload.byteLength.toString() },
      payload,
    });

    expect(response).toHaveProperty('statusCode', 400);
    expect(JSON.parse(response.payload)).toHaveProperty(
      'message',
      'Parcel recipient should be specified as a private address',
    );

    expect(mockParcelStore.storeGatewayBoundParcel).not.toBeCalled();
  });

  test('HTTP 403 should be returned if the parcel is well-formed but invalid', async () => {
    const error = new InvalidMessageError('Oops');
    getMockInstance(mockParcelStore.storeGatewayBoundParcel).mockReset();
    getMockInstance(mockParcelStore.storeGatewayBoundParcel).mockRejectedValueOnce(error);

    const response = await serverInstance.inject(validRequestOptions);

    expect(response).toHaveProperty('statusCode', 403);
    expect(JSON.parse(response.payload)).toEqual({
      message: 'The parcel is invalid',
    });

    // TODO: Find a way to spy on the error logger
    // expect(pinoErrorLogSpy).toBeCalledWith('The parcel is invalid', { err: error });
  });

  test('Failing to save parcel in object store should result in a 500 response', async () => {
    getMockInstance(mockParcelStore.storeGatewayBoundParcel).mockRejectedValue(new Error('Oops'));

    const response = await serverInstance.inject(validRequestOptions);

    expect(response).toHaveProperty('statusCode', 500);
    expect(JSON.parse(response.payload)).toEqual({
      message: 'Parcel could not be stored; please try again later',
    });

    // TODO: Find a way to spy on the error logger
    // expect(pinoErrorLogSpy).toBeCalledWith('Failed to queue ping message', { err: error });
  });

  test('Parcel should be bound for private gateway if valid', async () => {
    await serverInstance.inject(validRequestOptions);

    expect(mockParcelStore.storeGatewayBoundParcel).toBeCalledTimes(1);
    expect(mockParcelStore.storeGatewayBoundParcel).toBeCalledWith(
      expect.objectContaining({ id: PARCEL.id }),
      validRequestOptions.payload,
      mockFastifyMongooseObject.db,
      mockNatsClient,
      expect.objectContaining({ debug: expect.toBeFunction(), info: expect.toBeFunction() }),
    );
  });

  test('HTTP 202 should be returned if the parcel was successfully stored', async () => {
    const response = await serverInstance.inject(validRequestOptions);

    expect(response).toHaveProperty('statusCode', 202);
    expect(JSON.parse(response.payload)).toEqual({});
  });

  test('Current request id should be part of the client id in the NATS connection', async () => {
    await serverInstance.inject(validRequestOptions);

    expect(mockNatsClientInit).toBeCalledTimes(1);
    expect(mockNatsClientInit).toBeCalledWith(expect.stringMatching(/^pohttp-req-req-\w+$/));
  });
});
