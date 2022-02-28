import { EnvVarError } from 'env-var';
import { fastify, FastifyInstance, FastifyPluginCallback } from 'fastify';
import pino from 'pino';

import { MAX_RAMF_MESSAGE_SIZE } from '../constants';
import { MONGO_ENV_VARS } from '../testUtils/db';
import { configureMockEnvVars } from '../testUtils/envVars';
import { getMockContext, getMockInstance, mockSpy } from '../testUtils/jest';
import * as exitHandling from '../utilities/exitHandling';
import * as logging from '../utilities/logging';
import { configureFastify, runFastify } from './fastify';

const mockFastify: FastifyInstance = {
  listen: mockSpy(jest.fn()),
  ready: mockSpy(jest.fn()),
  register: mockSpy(jest.fn()),
} as any;
jest.mock('fastify', () => {
  return { fastify: jest.fn().mockImplementation(() => mockFastify) };
});

afterAll(() => {
  jest.restoreAllMocks();
});

const mockEnvVars = configureMockEnvVars(MONGO_ENV_VARS);

const mockMakeLogger = mockSpy(jest.spyOn(logging, 'makeLogger'));

const mockExitHandler = mockSpy(jest.spyOn(exitHandling, 'configureExitHandling'));

const dummyRoutes: FastifyPluginCallback = () => null;

describe('configureFastify', () => {
  test('Logger should be enabled by default', () => {
    configureFastify([dummyRoutes]);

    expect(mockMakeLogger).toBeCalledWith();
    const logger = getMockContext(mockMakeLogger).results[0].value;
    expect(fastify).toBeCalledWith(expect.objectContaining({ logger }));

    expect(mockExitHandler).toBeCalledWith(logger);
  });

  test('Custom logger should be honoured', () => {
    const customLogger = pino();
    configureFastify([dummyRoutes], undefined, customLogger);

    expect(fastify).toBeCalledWith(
      expect.objectContaining({
        logger: customLogger,
      }),
    );
    expect(mockExitHandler).toBeCalledWith(customLogger);
  });

  test('X-Request-Id should be the default request id header', () => {
    configureFastify([dummyRoutes]);

    const fastifyCallArgs = getMockContext(fastify).calls[0];
    expect(fastifyCallArgs[0]).toHaveProperty('requestIdHeader', 'x-request-id');
  });

  test('Custom request id header can be set via REQUEST_ID_HEADER variable', () => {
    const requestIdHeader = 'X-Id';
    mockEnvVars({ ...MONGO_ENV_VARS, REQUEST_ID_HEADER: requestIdHeader });

    configureFastify([dummyRoutes]);

    const fastifyCallArgs = getMockContext(fastify).calls[0];
    expect(fastifyCallArgs[0]).toHaveProperty('requestIdHeader', requestIdHeader.toLowerCase());
  });

  test('Maximum request body should allow for the largest RAMF message', () => {
    configureFastify([dummyRoutes]);

    const fastifyCallArgs = getMockContext(fastify).calls[0];
    expect(fastifyCallArgs[0]).toHaveProperty('bodyLimit', MAX_RAMF_MESSAGE_SIZE);
  });

  test('Proxy request headers should be trusted', () => {
    configureFastify([dummyRoutes]);

    const fastifyCallArgs = getMockContext(fastify).calls[0];
    expect(fastifyCallArgs[0]).toHaveProperty('trustProxy', true);
  });

  test('Routes should be loaded', async () => {
    await configureFastify([dummyRoutes]);

    expect(mockFastify.register).toBeCalledWith(dummyRoutes, undefined);
  });

  test('Routes should be "awaited" for', async () => {
    const error = new Error('Denied');
    getMockInstance(mockFastify.register).mockImplementation((plugin) => {
      if (plugin === dummyRoutes) {
        throw error;
      }
    });

    await expect(configureFastify([dummyRoutes])).rejects.toEqual(error);
  });

  test('Any route options should be passed when registering the route', async () => {
    const options = { foo: 'oof' };

    await configureFastify([dummyRoutes], options);

    expect(mockFastify.register).toBeCalledWith(dummyRoutes, options);
  });

  test('MongoDB connection arguments should be set', async () => {
    mockEnvVars({ MONGO_URI: undefined });

    await expect(configureFastify([dummyRoutes])).rejects.toBeInstanceOf(EnvVarError);
  });

  test('The fastify-mongoose plugin should be configured', async () => {
    await configureFastify([dummyRoutes]);

    expect(mockFastify.register).toBeCalledWith(
      require('fastify-mongoose'),
      expect.objectContaining({
        dbName: MONGO_ENV_VARS.MONGO_DB,
        uri: MONGO_ENV_VARS.MONGO_URI,
        user: MONGO_ENV_VARS.MONGO_USER,
      }),
    );
  });

  test('It should wait for the Fastify server to be ready', async () => {
    await configureFastify([dummyRoutes]);

    expect(mockFastify.ready).toBeCalledTimes(1);
  });

  test('Server instance should be returned', async () => {
    const serverInstance = await configureFastify([dummyRoutes]);

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
