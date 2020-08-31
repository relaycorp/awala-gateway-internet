/* tslint:disable:no-let */

import { generateRSAKeyPair, Parcel } from '@relaycorp/relaynet-core';
import { FastifyInstance, HTTPMethods } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { InjectOptions } from 'light-my-request';

import { mockSpy, PdaChain, sha256Hex } from '../../_test_utils';
import * as natsStreaming from '../../backingServices/natsStreaming';
import { ObjectStoreClient, StoreObject } from '../../backingServices/objectStorage';
import {
  configureMockEnvVars,
  generatePdaChain,
  generateStubEndpointCertificate,
  generateStubParcel,
} from '../_test_utils';
import * as certs from '../certs';
import { makeServer } from './server';

const mockFastifyPlugin = fastifyPlugin;
const mockFastifyMongooseObject = { db: { what: 'The mongoose.Connection' }, ObjectId: {} };
jest.mock('fastify-mongoose', () => {
  function mockFunc(fastify: FastifyInstance, _options: any, next: () => void): void {
    fastify.decorate('mongo', mockFastifyMongooseObject);
    next();
  }

  return mockFastifyPlugin(mockFunc, { name: 'fastify-mongoose' });
});

const validRequestOptions: InjectOptions = {
  headers: {
    'Content-Type': 'application/vnd.relaynet.parcel',
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
  (validRequestOptions.headers as { [key: string]: string })[
    'Content-Length'
  ] = payload.byteLength.toString();
});

const STUB_NATS_SERVER_URL = 'nats://example.com';
const STUB_NATS_CLUSTER_ID = 'nats-cluster-id';
let mockNatsClient: natsStreaming.NatsStreamingClient;
beforeEach(() => {
  mockNatsClient = ({
    disconnect: jest.fn(),
    publishMessage: jest.fn(),
  } as unknown) as natsStreaming.NatsStreamingClient;
});
const mockNatsClientClass = mockSpy(
  jest.spyOn(natsStreaming, 'NatsStreamingClient'),
  () => mockNatsClient,
);

const mockRetrieveOwnCertificates = mockSpy(
  jest.spyOn(certs, 'retrieveOwnCertificates'),
  async () => [stubPdaChain.publicGatewayCert],
);

const mockObjectStoreClient = {
  putObject: mockSpy(jest.fn()),
};
jest.spyOn(ObjectStoreClient, 'initFromEnv').mockReturnValue(
  // @ts-ignore
  mockObjectStoreClient,
);
const OBJECT_STORE_BUCKET = 'the-bucket';

describe('receiveParcel', () => {
  configureMockEnvVars({
    MONGO_URI: 'uri',
    NATS_CLUSTER_ID: STUB_NATS_CLUSTER_ID,
    NATS_SERVER_URL: STUB_NATS_SERVER_URL,
    OBJECT_STORE_BUCKET,
  });

  let serverInstance: FastifyInstance;
  beforeAll(async () => {
    serverInstance = await makeServer();
  });

  test.each(['PUT', 'PATCH', 'DELETE'] as readonly HTTPMethods[])(
    '%s requests should be refused',
    async (method) => {
      const response = await serverInstance.inject({
        ...validRequestOptions,
        method,
      });

      expect(response).toHaveProperty('statusCode', 405);
      expect(response).toHaveProperty('headers.allow', 'HEAD, GET, POST');
    },
  );

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

  test('Content-Type other than application/vnd.relaynet.parcel should be refused', async () => {
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

  test('Parcel should be refused if sender certification path is not trusted', async () => {
    const unauthorizedSenderKeyPair = await generateRSAKeyPair();
    const unauthorizedCert = await generateStubEndpointCertificate(unauthorizedSenderKeyPair);
    const parcel = await generateStubParcel({
      recipientAddress: await stubPdaChain.peerEndpointCert.calculateSubjectPrivateAddress(),
      senderCertificate: unauthorizedCert,
      senderCertificateChain: [stubPdaChain.privateGatewayCert],
    });
    const payload = Buffer.from(await parcel.serialize(unauthorizedSenderKeyPair.privateKey));
    const response = await serverInstance.inject({
      ...validRequestOptions,
      headers: { ...validRequestOptions.headers, 'Content-Length': payload.byteLength.toString() },
      payload,
    });

    expect(response).toHaveProperty('statusCode', 400);
    expect(JSON.parse(response.payload)).toHaveProperty(
      'message',
      'Parcel sender is not authorized',
    );

    expect(mockNatsClient.publishMessage).not.toBeCalled();
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

    expect(mockRetrieveOwnCertificates).not.toBeCalled();
    expect(mockNatsClient.publishMessage).not.toBeCalled();
  });

  describe('Valid parcel delivery', () => {
    let expectedObjectKey: string;
    beforeAll(async () => {
      expectedObjectKey = [
        'parcels',
        'gateway-bound',
        await stubPdaChain.privateGatewayCert.calculateSubjectPrivateAddress(),
        await stubPdaChain.peerEndpointCert.calculateSubjectPrivateAddress(),
        await stubPdaChain.pdaCert.calculateSubjectPrivateAddress(),
        sha256Hex(PARCEL.id),
      ].join('/');
    });

    test('202 response should be returned', async () => {
      const response = await serverInstance.inject(validRequestOptions);

      expect(response).toHaveProperty('statusCode', 202);
      expect(JSON.parse(response.payload)).toEqual({});
    });

    test('Parcel should be put in the right object store location', async () => {
      await serverInstance.inject(validRequestOptions);

      expect(mockObjectStoreClient.putObject).toBeCalledTimes(1);
      const expectedParcelExpiry = Math.floor(PARCEL.expiryDate.getTime() / 1_000).toString();
      const expectedStoreObject: StoreObject = {
        body: validRequestOptions.payload as Buffer,
        metadata: { 'parcel-expiry': expectedParcelExpiry },
      };
      expect(mockObjectStoreClient.putObject).toBeCalledWith(
        expectedStoreObject,
        expectedObjectKey,
        OBJECT_STORE_BUCKET,
      );
    });

    test('Failing to save parcel in object store should result in a 500 response', async () => {
      const error = new Error('Oops');
      mockObjectStoreClient.putObject.mockReset();
      mockObjectStoreClient.putObject.mockRejectedValueOnce(error);

      const response = await serverInstance.inject(validRequestOptions);

      expect(response).toHaveProperty('statusCode', 500);
      expect(JSON.parse(response.payload)).toEqual({
        message: 'Parcel could not be stored; please try again later',
      });
      expect(mockNatsClient.publishMessage).not.toBeCalled();

      // TODO: Find a way to spy on the error logger
      // expect(pinoErrorLogSpy).toBeCalledWith('Failed to queue ping message', { err: error });
    });

    test('Parcel object key should be published to right NATS Streaming channel', async () => {
      await serverInstance.inject(validRequestOptions);

      expect(mockNatsClientClass).toBeCalledTimes(1);
      expect(mockNatsClientClass).toBeCalledWith(
        STUB_NATS_SERVER_URL,
        STUB_NATS_CLUSTER_ID,
        expect.stringMatching(/^pohttp-req-\d+$/),
      );

      expect(mockNatsClient.publishMessage).toBeCalledTimes(1);
      expect(mockNatsClient.publishMessage).toBeCalledWith(
        expectedObjectKey,
        `pdc-parcel.${await stubPdaChain.privateGatewayCert.calculateSubjectPrivateAddress()}`,
      );
    });

    test('Failing to queue the parcel should result in a 500 response', async () => {
      const error = new Error('Oops');
      ((mockNatsClient.publishMessage as unknown) as jest.SpyInstance).mockReset();
      ((mockNatsClient.publishMessage as unknown) as jest.SpyInstance).mockRejectedValueOnce(error);

      const response = await serverInstance.inject(validRequestOptions);

      expect(response).toHaveProperty('statusCode', 500);
      expect(JSON.parse(response.payload)).toEqual({
        message: 'Parcel could not be stored; please try again later',
      });

      // TODO: Find a way to spy on the error logger
      // expect(pinoErrorLogSpy).toBeCalledWith('Failed to queue parcel', { err: error });
    });

    test('NATS connection should be closed upon successful completion', async () => {
      await serverInstance.inject(validRequestOptions);

      expect(mockNatsClient.disconnect).toBeCalledTimes(1);
    });

    test('NATS connection should be closed upon failure', async () => {
      const error = new Error('Oops');
      ((mockNatsClient.publishMessage as unknown) as jest.SpyInstance).mockReset();
      ((mockNatsClient.publishMessage as unknown) as jest.SpyInstance).mockRejectedValueOnce(error);

      await serverInstance.inject(validRequestOptions);

      expect(mockNatsClient.disconnect).toBeCalledTimes(1);
    });
  });
});
