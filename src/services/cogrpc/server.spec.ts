/* tslint:disable:no-let */

import { CargoRelayService } from '@relaycorp/relaynet-cogrpc';
import { EnvVarError } from 'env-var';
import * as grpc from 'grpc';

import { mockSpy } from '../../_test_utils';
import { configureMockEnvVars } from '../_test_utils';
import { MAX_RAMF_MESSAGE_SIZE } from '../constants';
import { runServer } from './server';
import * as cogrpcService from './service';

const makeServiceImplementationSpy = mockSpy(
  jest.spyOn(cogrpcService, 'makeServiceImplementation'),
);
const mockServer = {
  addService: mockSpy(jest.fn()),
  bind: mockSpy(jest.fn(), () => 1),
  start: mockSpy(jest.fn()),
};
jest.mock('grpc', () => {
  const grpcOriginal = jest.requireActual('grpc');
  return {
    ...grpcOriginal,
    Server: jest.fn().mockImplementation(() => mockServer),
  };
});

const BASE_ENV_VARS = {
  COGRPC_ADDRESS: 'https://cogrpc.example.com/',
  GATEWAY_KEY_ID: 'base64-encoded key id',
  MONGO_URI: 'mongo://example.com',
  NATS_CLUSTER_ID: 'nats-cluster-id',
  NATS_SERVER_URL: 'nats://example.com',
  PARCEL_STORE_BUCKET: 'bucket-name',
};
const mockEnvVars = configureMockEnvVars(BASE_ENV_VARS);

describe('runServer', () => {
  test.each([
    'GATEWAY_KEY_ID',
    'MONGO_URI',
    'NATS_SERVER_URL',
    'NATS_CLUSTER_ID',
    'COGRPC_ADDRESS',
    'PARCEL_STORE_BUCKET',
  ])('Environment variable %s should be present', envVar => {
    mockEnvVars({ ...BASE_ENV_VARS, [envVar]: undefined });

    expect(runServer).toThrowWithMessage(EnvVarError, new RegExp(envVar));
  });

  test('Server should accept the largest possible RAMF messages', () => {
    const expectMaxLength = MAX_RAMF_MESSAGE_SIZE + 256;

    runServer();

    expect(grpc.Server).toBeCalledWith(
      expect.objectContaining({ 'grpc.max_receive_message_length': expectMaxLength }),
    );
  });

  test('Server should accept metadata of up to 3.5 kb', () => {
    runServer();

    expect(grpc.Server).toBeCalledWith(
      expect.objectContaining({ 'grpc.max_metadata_size': 3_500 }),
    );
  });

  test('Server should accept up to 3 concurrent calls per connection', () => {
    runServer();

    expect(grpc.Server).toBeCalledWith(
      expect.objectContaining({ 'grpc.max_concurrent_streams': 3 }),
    );
  });

  test('Server should allow connections to last up to 15 minutes', () => {
    runServer();

    expect(grpc.Server).toBeCalledWith(
      expect.objectContaining({ 'grpc.max_connection_age_ms': 15 * 60 * 1_000 }),
    );
  });

  test('Server should allow clients to gracefully end connections in up to 30 seconds', () => {
    runServer();

    expect(grpc.Server).toBeCalledWith(
      expect.objectContaining({ 'grpc.max_connection_age_grace_ms': 30_000 }),
    );
  });

  test('Server should allow connections to go idle for up to 5 seconds', () => {
    runServer();

    expect(grpc.Server).toBeCalledWith(
      expect.objectContaining({ 'grpc.max_connection_idle_ms': 5_000 }),
    );
  });

  test('CogRPC service should be added', () => {
    runServer();

    expect(makeServiceImplementationSpy).toBeCalledTimes(1);
    expect(makeServiceImplementationSpy).toBeCalledWith({
      cogrpcAddress: BASE_ENV_VARS.COGRPC_ADDRESS,
      gatewayKeyIdBase64: BASE_ENV_VARS.GATEWAY_KEY_ID,
      mongoUri: BASE_ENV_VARS.MONGO_URI,
      natsClusterId: BASE_ENV_VARS.NATS_CLUSTER_ID,
      natsServerUrl: BASE_ENV_VARS.NATS_SERVER_URL,
      parcelStoreBucket: BASE_ENV_VARS.PARCEL_STORE_BUCKET,
    });
    const serviceImplementation = makeServiceImplementationSpy.mock.results[0].value;

    expect(mockServer.addService).toBeCalledTimes(1);
    expect(mockServer.addService).toBeCalledWith(CargoRelayService, serviceImplementation);
  });

  test('Server should listen on 0.0.0.0:8080', () => {
    runServer();

    expect(mockServer.bind).toBeCalledTimes(1);
    expect(mockServer.bind).toBeCalledWith('0.0.0.0:8080', expect.anything());
  });

  test('Failing to listen on specified port should result in error', () => {
    mockServer.bind.mockReturnValueOnce(-1);

    expect(() => runServer()).toThrowWithMessage(Error, 'Failed to listen on 0.0.0.0:8080');
  });

  test('Server should not use TLS', () => {
    runServer();

    expect(mockServer.bind).toBeCalledTimes(1);
    expect(mockServer.bind).toBeCalledWith(
      expect.anything(),
      grpc.ServerCredentials.createInsecure(),
    );
  });

  test('gRPC server should be started as the last step', () => {
    runServer();

    expect(mockServer.start).toBeCalledTimes(1);
    expect(mockServer.start).toBeCalledWith();
    expect(mockServer.start).toHaveBeenCalledAfter(mockServer.bind as jest.Mock);
  });
});
