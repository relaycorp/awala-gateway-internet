/* tslint:disable:no-let */

import { CargoRelayService } from '@relaycorp/relaynet-cogrpc';
import { EnvVarError } from 'env-var';
import * as grpc from 'grpc';

import { mockSpy } from '../../_test_utils';
import { configureMockEnvVars } from '../_test_utils';
import { runServer } from './server';
import * as cogrpcService from './service';

const addServiceSpy = jest.spyOn(grpc.Server.prototype, 'addService');
const bindSpy = jest.spyOn(grpc.Server.prototype, 'bind');
const startSpy = jest.spyOn(grpc.Server.prototype, 'start');
const makeServiceImplementationSpy = mockSpy(
  jest.spyOn(cogrpcService, 'makeServiceImplementation'),
);
beforeEach(() => {
  addServiceSpy.mockReset();
  bindSpy.mockReset();
  startSpy.mockReset();
});

const BASE_ENV_VARS = {
  COGRPC_ADDRESS: 'https://cogrpc.example.com/',
  MONGO_URI: 'mongo://example.com',
  NATS_CLUSTER_ID: 'nats-cluster-id',
  NATS_SERVER_URL: 'nats://example.com',
};
const mockEnvVars = configureMockEnvVars(BASE_ENV_VARS);

describe('runServer', () => {
  test.each(['MONGO_URI', 'NATS_SERVER_URL', 'NATS_CLUSTER_ID', 'COGRPC_ADDRESS'])(
    'Environment variable %s should be present',
    envVar => {
      mockEnvVars({ ...BASE_ENV_VARS, [envVar]: undefined });

      expect(runServer).toThrowWithMessage(EnvVarError, new RegExp(envVar));
    },
  );

  test('CogRPC service should be added', () => {
    runServer();

    expect(makeServiceImplementationSpy).toBeCalledTimes(1);
    expect(makeServiceImplementationSpy).toBeCalledWith({
      cogrpcAddress: BASE_ENV_VARS.COGRPC_ADDRESS,
      mongoUri: BASE_ENV_VARS.MONGO_URI,
      natsClusterId: BASE_ENV_VARS.NATS_CLUSTER_ID,
      natsServerUrl: BASE_ENV_VARS.NATS_SERVER_URL,
    });
    const serviceImplementation = makeServiceImplementationSpy.mock.results[0].value;

    expect(addServiceSpy).toBeCalledTimes(1);
    expect(addServiceSpy).toBeCalledWith(CargoRelayService, serviceImplementation);
  });

  test('Server should listen on 0.0.0.0:8080', () => {
    runServer();

    expect(bindSpy).toBeCalledTimes(1);
    expect(bindSpy).toBeCalledWith('0.0.0.0:8080', expect.anything());
  });

  test('Failing to listen on specified port should result in error', () => {
    bindSpy.mockReturnValueOnce(-1);

    expect(() => runServer()).toThrowWithMessage(Error, 'Failed to listen on 0.0.0.0:8080');
  });

  test('Server should not use TLS', () => {
    runServer();

    expect(bindSpy).toBeCalledTimes(1);
    expect(bindSpy).toBeCalledWith(expect.anything(), grpc.ServerCredentials.createInsecure());
  });

  test('gRPC server should be started as the last step', () => {
    runServer();

    expect(startSpy).toBeCalledTimes(1);
    expect(startSpy).toBeCalledWith();
    expect(startSpy).toHaveBeenCalledAfter(bindSpy as jest.Mock);
  });
});
