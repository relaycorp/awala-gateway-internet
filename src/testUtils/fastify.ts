import { FastifyInstance, HTTPMethods } from 'fastify';
import { Connection } from 'mongoose';

import { HTTP_METHODS } from '../utilities/fastify/server';
import { makeMockLogging, MockLogSet } from './logging';
import { configureMockEnvVars, EnvVarMocker, EnvVarSet } from './envVars';
import type { ServerMaker } from '../utilities/fastify/ServerMaker';
import { setUpTestDBConnection } from './db';

export interface TestServerFixture {
  readonly server: FastifyInstance;
  readonly dbConnection: Connection;
  readonly logs: MockLogSet;
  readonly envVarMocker: EnvVarMocker;
}

export type TestServerFixtureRetriever = () => TestServerFixture;

export function makeTestServer(
  serverMaker: ServerMaker,
  envVars: EnvVarSet,
): TestServerFixtureRetriever {
  const envVarMocker = configureMockEnvVars(envVars);
  const getConnection = setUpTestDBConnection();

  const mockLogging = makeMockLogging();
  beforeEach(() => {
    // Clear the logs
    mockLogging.logs.splice(0, mockLogging.logs.length);
  });

  let server: FastifyInstance;
  beforeEach(async () => {
    server = await serverMaker(mockLogging.logger);
  });

  afterEach(async () => {
    await server.close();
  });

  return () => ({
    server,
    dbConnection: getConnection(),
    logs: mockLogging.logs,
    envVarMocker,
  });
}

export function testDisallowedMethods(
  allowedMethods: readonly HTTPMethods[],
  endpointURL: string,
  initFastify: () => Promise<FastifyInstance>,
): void {
  let fastify: FastifyInstance;
  beforeEach(async () => {
    fastify = await initFastify();
  });
  afterEach(async () => {
    await fastify.close();
  });

  const allowedMethodsString = allowedMethods.join(', ');

  const disallowedMethods = HTTP_METHODS.filter(
    (m) => !allowedMethods.includes(m) && m !== 'OPTIONS',
  );
  test.each(disallowedMethods)('%s requests should be refused', async (method) => {
    const response = await fastify.inject({ method: method as any, url: endpointURL });

    expect(response).toHaveProperty('statusCode', 405);
    expect(response).toHaveProperty('headers.allow', allowedMethodsString);
  });

  test('OPTIONS requests should list the allowed methods', async () => {
    const response = await fastify.inject({ method: 'OPTIONS', url: endpointURL });

    expect(response).toHaveProperty('statusCode', 204);
    expect(response).toHaveProperty('headers.allow', allowedMethodsString);
  });
}
