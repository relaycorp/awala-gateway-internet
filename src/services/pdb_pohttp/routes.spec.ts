/* tslint:disable:no-let */

import { generateRSAKeyPair } from '@relaycorp/relaynet-core';
import { FastifyInstance, HTTPInjectOptions, HTTPMethod } from 'fastify';
import fastifyPlugin from 'fastify-plugin';

import {
  configureMockEnvVars,
  generateStubEndpointCertificate,
  generateStubParcel,
  generateStubPdaChain,
  PdaChain,
} from '../_test_utils';
import * as certs from '../certs';
import * as nats from '../nats';
import { makeServer } from './server';

configureMockEnvVars({ MONGO_URI: 'uri' });

const mockFastifyPlugin = fastifyPlugin;
const mockFastifyMongooseObject = { db: { what: 'The mongoose.Connection' }, ObjectId: {} };
jest.mock('fastify-mongoose', () => {
  function mockFunc(fastify: FastifyInstance, _options: any, next: () => void): void {
    fastify.decorate('mongo', mockFastifyMongooseObject);
    next();
  }

  return mockFastifyPlugin(mockFunc, { name: 'fastify-mongoose' });
});

let serverInstance: FastifyInstance;
beforeAll(async () => {
  serverInstance = await makeServer();
});

const gatewayAddress = 'gw.relaycorp.tech:8000';
const validRequestOptions: HTTPInjectOptions = {
  headers: {
    'Content-Type': 'application/vnd.relaynet.parcel',
    Host: gatewayAddress,
  },
  method: 'POST',
  url: '/',
};
let stubPdaChain: PdaChain;

beforeAll(async () => {
  stubPdaChain = await generateStubPdaChain();

  const payload = await generateStubParcel({
    recipientAddress: await stubPdaChain.peerEndpoint.calculateSubjectPrivateAddress(),
    senderCertificate: stubPdaChain.pda,
    senderCertificateChain: [stubPdaChain.peerEndpoint, stubPdaChain.localGateway],
    senderPrivateKey: stubPdaChain.pdaGranteePrivateKey,
  });
  // tslint:disable-next-line:no-object-mutation
  validRequestOptions.payload = payload;
  // tslint:disable-next-line:readonly-keyword no-object-mutation
  (validRequestOptions.headers as { [key: string]: string })[
    'Content-Length'
  ] = payload.byteLength.toString();
});

const mockPublishMessage = jest.spyOn(nats, 'publishMessage');
beforeEach(() => {
  mockPublishMessage.mockReset();
  mockPublishMessage.mockResolvedValueOnce();
});
afterAll(() => mockPublishMessage.mockRestore());

const mockRetrieveOwnCertificates = jest.spyOn(certs, 'retrieveOwnCertificates');
beforeEach(() => {
  mockRetrieveOwnCertificates.mockReset();
  mockRetrieveOwnCertificates.mockImplementation(async () => [stubPdaChain.relayingGateway]);
});
afterAll(() => mockRetrieveOwnCertificates.mockRestore());

describe('receiveParcel', () => {
  test.each(['PUT', 'PATCH', 'DELETE'] as readonly HTTPMethod[])(
    '%s requests should be refused',
    async method => {
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

  test.skip('Parcel should be refused if sender certification path is not trusted', async () => {
    const unauthorizedSenderKeyPair = await generateRSAKeyPair();
    const unauthorizedCert = await generateStubEndpointCertificate(unauthorizedSenderKeyPair);
    const payload = await generateStubParcel({
      recipientAddress: await stubPdaChain.peerEndpoint.calculateSubjectPrivateAddress(),
      senderCertificate: unauthorizedCert,
      senderCertificateChain: [stubPdaChain.localGateway],
      senderPrivateKey: unauthorizedSenderKeyPair.privateKey,
    });
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

    expect(mockRetrieveOwnCertificates).toBeCalledTimes(1);
    expect(mockRetrieveOwnCertificates).toBeCalledWith(mockFastifyMongooseObject.db);

    expect(mockPublishMessage).not.toBeCalled();
  });

  describe('Valid parcel delivery', () => {
    test('202 response should be returned', async () => {
      const response = await serverInstance.inject(validRequestOptions);

      expect(response).toHaveProperty('statusCode', 202);
      expect(JSON.parse(response.payload)).toEqual({});
    });

    test('Parcel should be published to right topic', async () => {
      await serverInstance.inject(validRequestOptions);

      expect(mockPublishMessage).toBeCalledTimes(1);
      expect(mockPublishMessage).toBeCalledWith(
        validRequestOptions.payload,
        `crc-parcel.${await stubPdaChain.localGateway.calculateSubjectPrivateAddress()}`,
      );
    });

    test('Failing to queue the ping message should result in a 500 response', async () => {
      const error = new Error('Oops');
      mockPublishMessage.mockReset();
      mockPublishMessage.mockRejectedValueOnce(error);

      const response = await serverInstance.inject(validRequestOptions);

      expect(response).toHaveProperty('statusCode', 500);
      expect(JSON.parse(response.payload)).toEqual({
        message: 'Parcel could not be stored; please try again later',
      });

      // TODO: Find a way to spy on the error logger
      // expect(pinoErrorLogSpy).toBeCalledWith('Failed to queue ping message', { err: error });
    });
  });
});
