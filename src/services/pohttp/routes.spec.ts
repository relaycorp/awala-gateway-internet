import { Certificate, InvalidMessageError, Parcel } from '@relaycorp/relaynet-core';
import { FastifyInstance } from 'fastify';
import { InjectOptions } from 'light-my-request';

import { ParcelStore } from '../../parcelStore';
import { setUpTestDBConnection } from '../../testUtils/db';
import { configureMockEnvVars } from '../../testUtils/envVars';
import { testDisallowedMethods } from '../../testUtils/fastify';
import { getMockInstance, mockSpy } from '../../testUtils/jest';
import { generatePdaChain, PdaChain } from '../../testUtils/pki';
import { makeServer } from './server';
import { mockRedisPubSubClient } from '../../testUtils/redis';

jest.mock('../../utilities/exitHandling');

const getMongooseConnection = setUpTestDBConnection();

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

interface StubParcelOptions {
  readonly recipientId: string;
  readonly senderCertificate: Certificate;
  readonly senderCertificateChain?: readonly Certificate[];
}

beforeAll(async () => {
  stubPdaChain = await generatePdaChain();

  PARCEL = await generateStubParcel({
    recipientId: await stubPdaChain.peerEndpointCert.calculateSubjectId(),
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

const mockParcelStore: ParcelStore = {
  storeParcelForPrivatePeer: mockSpy(jest.fn(), async () => undefined),
} as any;
jest.spyOn(ParcelStore, 'initFromEnv').mockReturnValue(mockParcelStore);

describe('receiveParcel', () => {
  configureMockEnvVars({ GATEWAY_VERSION: '1.0.2' });

  const redisPubSubClient = mockRedisPubSubClient();

  let serverInstance: FastifyInstance;
  beforeEach(async () => {
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

  test('HTTP 403 should be returned if the parcel is well-formed but invalid', async () => {
    const error = new InvalidMessageError('Oops');
    getMockInstance(mockParcelStore.storeParcelForPrivatePeer).mockReset();
    getMockInstance(mockParcelStore.storeParcelForPrivatePeer).mockRejectedValueOnce(error);

    const response = await serverInstance.inject(validRequestOptions);

    expect(response).toHaveProperty('statusCode', 403);
    expect(JSON.parse(response.payload)).toEqual({
      message: `Invalid parcel: ${error.message}`,
    });

    // TODO: Find a way to check the logs
  });

  test('Failing to save parcel in object store should result in a 500 response', async () => {
    getMockInstance(mockParcelStore.storeParcelForPrivatePeer).mockRejectedValue(new Error('Oops'));

    const response = await serverInstance.inject(validRequestOptions);

    expect(response).toHaveProperty('statusCode', 500);
    expect(JSON.parse(response.payload)).toEqual({
      message: 'Parcel could not be stored; please try again later',
    });

    // TODO: Find a way to check the logs
    // expect(pinoErrorLogSpy).toBeCalledWith('Failed to queue ping message', { err: error });
  });

  test('Parcel should be bound for private gateway if valid', async () => {
    await serverInstance.inject(validRequestOptions);

    expect(mockParcelStore.storeParcelForPrivatePeer).toBeCalledTimes(1);
    expect(mockParcelStore.storeParcelForPrivatePeer).toBeCalledWith(
      expect.objectContaining({ id: PARCEL.id }),
      validRequestOptions.payload,
      getMongooseConnection(),
      redisPubSubClient.publishers[0].publish,
      expect.objectContaining({ debug: expect.toBeFunction(), info: expect.toBeFunction() }),
    );
  });

  test('HTTP 202 should be returned if the parcel was successfully stored', async () => {
    const response = await serverInstance.inject(validRequestOptions);

    expect(response).toHaveProperty('statusCode', 202);
    expect(JSON.parse(response.payload)).toEqual({});
    // TODO: Find a way to check the logs
  });

  test('Redis connection should be closed when server ends', async () => {
    const publisher = redisPubSubClient.publishers[0];
    expect(publisher.close).not.toBeCalled();

    await serverInstance.close();

    expect(publisher.close).toBeCalled();
  });
});

async function generateStubParcel(options: StubParcelOptions): Promise<Parcel> {
  return new Parcel(
    { id: options.recipientId },
    options.senderCertificate,
    Buffer.from('the payload'),
    { senderCaCertificateChain: options.senderCertificateChain ?? [] },
  );
}
