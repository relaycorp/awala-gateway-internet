/* tslint:disable:no-let */

import { CargoRelayService } from '@relaycorp/relaynet-cogrpc';
import * as grpc from 'grpc';

import { runServer } from './server';
import * as cogrpcService from './service';

const addServiceSpy = jest.spyOn(grpc.Server.prototype, 'addService');
const bindSpy = jest.spyOn(grpc.Server.prototype, 'bind');
const startSpy = jest.spyOn(grpc.Server.prototype, 'start');
beforeEach(() => {
  addServiceSpy.mockReset();
  bindSpy.mockReset();
  startSpy.mockReset();
});

describe('runServer', () => {
  test('CogRPC service should be added', () => {
    runServer();

    expect(addServiceSpy).toBeCalledTimes(1);
    expect(addServiceSpy).toBeCalledWith(CargoRelayService, cogrpcService);
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
