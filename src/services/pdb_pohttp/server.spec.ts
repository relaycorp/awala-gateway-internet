import { getMockContext } from '../_test_utils';
import * as server from './server';

import fastify = require('fastify');

const mockFastify = {
  addContentTypeParser: jest.fn(),
  listen: jest.fn(),
  ready: jest.fn(),
  register: jest.fn(),
};
jest.mock('fastify', () => jest.fn().mockImplementation(() => mockFastify));

afterAll(() => {
  jest.restoreAllMocks();
});

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
    // tslint:disable-next-line:no-object-mutation
    process.env.REQUEST_ID_HEADER = requestIdHeader;

    server.makeServer();

    const fastifyCallArgs = getMockContext(fastify).calls[0];
    expect(fastifyCallArgs[0]).toHaveProperty('requestIdHeader', requestIdHeader);
  });

  test('Content-Type application/vnd.relaynet.parcel should be supported', () => {
    server.makeServer();

    expect(mockFastify.addContentTypeParser).toBeCalledTimes(1);
    const addContentTypeParserCallArgs = getMockContext(mockFastify.addContentTypeParser).calls[0];
    expect(addContentTypeParserCallArgs[0]).toEqual('application/vnd.relaynet.parcel');
    expect(addContentTypeParserCallArgs[1]).toEqual({ parseAs: 'buffer' });

    // It shouldn't actually parse the body just yet:
    const parser = addContentTypeParserCallArgs[2];
    const stubBody = {};
    expect(parser({}, stubBody)).resolves.toBe(stubBody);
  });

  test('Routes should be loaded', () => {
    server.makeServer();

    expect(mockFastify.register).toBeCalledWith(require('./routes').default);
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
