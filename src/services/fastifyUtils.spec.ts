import { EnvVarError } from 'env-var';
import { fastify, FastifyInstance, FastifyPluginCallback } from 'fastify';

import { configureMockEnvVars, getMockContext, getMockInstance } from './_test_utils';
import { configureFastify, runFastify } from './fastifyUtils';

const mockFastify: FastifyInstance = {
  listen: jest.fn(),
  ready: jest.fn(),
  register: jest.fn(),
} as any;
jest.mock('fastify', () => {
  return { fastify: jest.fn().mockImplementation(() => mockFastify) };
});

afterAll(() => {
  jest.restoreAllMocks();
});

const stubMongoUri = 'mongodb://mongodb/test_db';
const mockEnvVars = configureMockEnvVars({ MONGO_URI: stubMongoUri });

const dummyRoutes: FastifyPluginCallback = () => null;

describe('configureFastify', () => {
  test('Logger should be enabled', () => {
    configureFastify(dummyRoutes);

    const fastifyCallArgs = getMockContext(fastify).calls[0];
    expect(fastifyCallArgs[0]).toHaveProperty('logger', true);
  });

  test('X-Request-Id should be the default request id header', () => {
    configureFastify(dummyRoutes);

    const fastifyCallArgs = getMockContext(fastify).calls[0];
    expect(fastifyCallArgs[0]).toHaveProperty('requestIdHeader', 'X-Request-Id');
  });

  test('Custom request id header can be set via REQUEST_ID_HEADER variable', () => {
    const requestIdHeader = 'X-Id';
    mockEnvVars({ MONGO_URI: stubMongoUri, REQUEST_ID_HEADER: requestIdHeader });

    configureFastify(dummyRoutes);

    const fastifyCallArgs = getMockContext(fastify).calls[0];
    expect(fastifyCallArgs[0]).toHaveProperty('requestIdHeader', requestIdHeader);
  });

  test('Routes should be loaded', () => {
    configureFastify(dummyRoutes);

    expect(mockFastify.register).toBeCalledWith(dummyRoutes);
  });

  test('The env var MONGO_URI should be set', async () => {
    mockEnvVars({ MONGO_URI: undefined });

    await expect(configureFastify(dummyRoutes)).rejects.toBeInstanceOf(EnvVarError);
  });

  test('The fastify-mongoose plugin should be configured', async () => {
    await configureFastify(dummyRoutes);

    expect(mockFastify.register).toBeCalledWith(require('fastify-mongoose'), {
      uri: stubMongoUri,
    });
  });

  test('It should wait for the Fastify server to be ready', async () => {
    await configureFastify(dummyRoutes);

    expect(mockFastify.ready).toBeCalledTimes(1);
  });

  test('Server instance should be returned', async () => {
    const serverInstance = await configureFastify(dummyRoutes);

    expect(serverInstance).toBe(mockFastify);
  });
});

describe('runFastify', () => {
  test('Server returned by makeServer() should be used', async () => {
    await runFastify(mockFastify);

    expect(mockFastify.listen).toBeCalledTimes(1);
  });

  test('Server should listen on port 8080', async () => {
    await runFastify(mockFastify);

    const listenCallArgs = getMockContext(mockFastify.listen).calls[0];
    expect(listenCallArgs[0]).toHaveProperty('port', 8080);
  });

  test('Server should listen on 0.0.0.0', async () => {
    await runFastify(mockFastify);

    expect(mockFastify.listen).toBeCalledTimes(1);
    const listenCallArgs = getMockContext(mockFastify.listen).calls[0];
    expect(listenCallArgs[0]).toHaveProperty('host', '0.0.0.0');
  });

  test('listen() call should be "awaited" for', async () => {
    const error = new Error('Denied');
    getMockInstance(mockFastify.listen).mockRejectedValueOnce(error);

    await expect(runFastify(mockFastify)).rejects.toEqual(error);
  });
});
