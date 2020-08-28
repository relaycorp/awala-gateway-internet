import { EnvVarError } from 'env-var';
import { fastify } from 'fastify';

import { configureMockEnvVars, getMockContext } from '../_test_utils';
import * as server from './server';

const mockFastify = {
  listen: jest.fn(),
  ready: jest.fn(),
  register: jest.fn(),
};
jest.mock('fastify', () => {
  return { fastify: jest.fn().mockImplementation(() => mockFastify) };
});

afterAll(() => {
  jest.restoreAllMocks();
});

const stubMongoUri = 'mongodb://mongodb/test_db';
const mockEnvVars = configureMockEnvVars({ MONGO_URI: stubMongoUri });

describe('makeServer', () => {
  test('Logger should be enabled', () => {
    server.makeServer();

    const fastifyCallArgs = getMockContext(fastify).calls[0];
    expect(fastifyCallArgs[0]).toHaveProperty('logger', true);
  });

  test('X-Request-Id should be the default request id header', () => {
    server.makeServer();

    const fastifyCallArgs = getMockContext(fastify).calls[0];
    expect(fastifyCallArgs[0]).toHaveProperty('requestIdHeader', 'X-Request-Id');
  });

  test('Custom request id header can be set via REQUEST_ID_HEADER variable', () => {
    const requestIdHeader = 'X-Id';
    mockEnvVars({ MONGO_URI: stubMongoUri, REQUEST_ID_HEADER: requestIdHeader });

    server.makeServer();

    const fastifyCallArgs = getMockContext(fastify).calls[0];
    expect(fastifyCallArgs[0]).toHaveProperty('requestIdHeader', requestIdHeader);
  });

  test('Routes should be loaded', () => {
    server.makeServer();

    expect(mockFastify.register).toBeCalledWith(require('./routes').default);
  });

  test('The env var MONGO_URI should be set', async () => {
    mockEnvVars({ MONGO_URI: undefined });

    await expect(server.makeServer()).rejects.toBeInstanceOf(EnvVarError);
  });

  test('The fastify-mongoose plugin should be configured', async () => {
    await server.makeServer();

    expect(mockFastify.register).toBeCalledWith(require('fastify-mongoose'), {
      uri: stubMongoUri,
    });
  });

  test('It should wait for the Fastify server to be ready', async () => {
    await server.makeServer();

    expect(mockFastify.ready).toBeCalledTimes(1);
  });

  test('Server instance should be returned', async () => {
    const serverInstance = await server.makeServer();

    expect(serverInstance).toBe(mockFastify);
  });
});

describe('runServer', () => {
  test('Server returned by server.makeServer() should be used', async () => {
    await server.runServer();

    expect(mockFastify.listen).toBeCalledTimes(1);
  });

  test('Server should listen on port 8080', async () => {
    await server.runServer();

    const listenCallArgs = getMockContext(mockFastify.listen).calls[0];
    expect(listenCallArgs[0]).toHaveProperty('port', 8080);
  });

  test('Server should listen on 0.0.0.0', async () => {
    await server.runServer();

    expect(mockFastify.listen).toBeCalledTimes(1);
    const listenCallArgs = getMockContext(mockFastify.listen).calls[0];
    expect(listenCallArgs[0]).toHaveProperty('host', '0.0.0.0');
  });

  test('listen() call should be "awaited" for', async () => {
    const error = new Error('Denied');
    mockFastify.listen.mockRejectedValueOnce(error);

    await expect(server.runServer()).rejects.toEqual(error);
  });
});
