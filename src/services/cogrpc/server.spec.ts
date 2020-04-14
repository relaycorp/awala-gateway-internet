/* tslint:disable:no-let */

import { CargoRelayService } from '@relaycorp/relaynet-cogrpc';
import { EnvVarError } from 'env-var';
import * as grpc from 'grpc';

import { configureMockEnvVars, mockSpy } from '../_test_utils';
import { MAX_RAMF_MESSAGE_SIZE } from '../constants';
import { runServer } from './server';
import * as cogrpcService from './service';

const makeServiceImplementationSpy = mockSpy(
  jest.spyOn(cogrpcService, 'makeServiceImplementation'),
);
const mockServer = {
  addService: jest.fn(),
  bind: jest.fn(),
  start: jest.fn(),
};
beforeEach(() => {
  mockServer.addService.mockReset();
  mockServer.bind.mockReset();
  mockServer.start.mockReset();
});
jest.mock('grpc', () => {
  const grpcOriginal = jest.requireActual('grpc');
  return {
    ...grpcOriginal,
    Server: jest.fn().mockImplementation(() => mockServer),
  };
});

const stubMongoUri = 'mongo://example.com';
const stubNatsServerUrl = 'nats://example.com';
const stubNatsClusterId = 'nats-cluster-id';
const BASE_ENV_VARS = {
  MONGO_URI: stubMongoUri,
  NATS_CLUSTER_ID: stubNatsClusterId,
  NATS_SERVER_URL: stubNatsServerUrl,
};
const mockEnvVars = configureMockEnvVars(BASE_ENV_VARS);

describe('runServer', () => {
  test.each(['MONGO_URI', 'NATS_SERVER_URL', 'NATS_CLUSTER_ID'])(
    'Environment variable %s should be present',
    envVar => {
      mockEnvVars({ ...BASE_ENV_VARS, [envVar]: undefined });

      expect(runServer).toThrowWithMessage(EnvVarError, new RegExp(envVar));
    },
  );

  test('Server should be configured to accept the largest possible RAMF messages', () => {
    const expectMaxLength = MAX_RAMF_MESSAGE_SIZE + 256;

    runServer();

    expect(grpc.Server).toBeCalledTimes(1);
    expect(grpc.Server).toBeCalledWith(
      expect.objectContaining({
        'grpc.max_receive_message_length': expectMaxLength,
      }),
    );
  });

  test('CogRPC service should be added', () => {
    runServer();

    expect(makeServiceImplementationSpy).toBeCalledTimes(1);
    expect(makeServiceImplementationSpy).toBeCalledWith({
      mongoUri: stubMongoUri,
      natsClusterId: stubNatsClusterId,
      natsServerUrl: stubNatsServerUrl,
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
