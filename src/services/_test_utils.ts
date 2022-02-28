import { Certificate, Parcel } from '@relaycorp/relaynet-core';
import { addDays } from 'date-fns';
import envVar from 'env-var';
import { FastifyInstance, HTTPMethods } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { Connection } from 'mongoose';
import * as stan from 'node-nats-streaming';

import { HTTP_METHODS } from './fastify';

export const TOMORROW = addDays(new Date(), 1);

export function getMockInstance(mockedObject: any): jest.MockInstance<any, any> {
  return mockedObject as unknown as jest.MockInstance<any, any>;
}

export function getMockContext(mockedObject: any): jest.MockContext<any, any> {
  const mockInstance = getMockInstance(mockedObject);
  return mockInstance.mock;
}

interface EnvVarSet {
  readonly [key: string]: string | undefined;
}

export function configureMockEnvVars(envVars: EnvVarSet = {}): (envVars: EnvVarSet) => void {
  const mockEnvVarGet = jest.spyOn(envVar, 'get');

  function setEnvVars(newEnvVars: EnvVarSet): void {
    mockEnvVarGet.mockReset();
    mockEnvVarGet.mockImplementation((...args: readonly any[]) => {
      const originalEnvVar = jest.requireActual('env-var');
      const env = originalEnvVar.from(newEnvVars);

      return env.get(...args);
    });
  }

  beforeAll(() => setEnvVars(envVars));
  beforeEach(() => setEnvVars(envVars));

  afterAll(() => {
    mockEnvVarGet.mockRestore();
  });

  return (newEnvVars: EnvVarSet) => setEnvVars(newEnvVars);
}

export function castMock<T>(partialMock: Partial<T>): T {
  return partialMock as unknown as T;
}

export interface StubParcelOptions {
  readonly recipientAddress: string;
  readonly senderCertificate: Certificate;
  readonly senderCertificateChain?: readonly Certificate[];
}

export async function generateStubParcel(options: StubParcelOptions): Promise<Parcel> {
  return new Parcel(
    options.recipientAddress,
    options.senderCertificate,
    Buffer.from('the payload'),
    { senderCaCertificateChain: options.senderCertificateChain ?? [] },
  );
}

export function mockStanMessage(messageData: Buffer | ArrayBuffer): stan.Message {
  return castMock<stan.Message>({
    ack: jest.fn(),
    getRawData: () => Buffer.from(messageData),
  });
}

export function testDisallowedMethods(
  allowedMethods: readonly HTTPMethods[],
  endpointURL: string,
  initFastify: () => Promise<FastifyInstance>,
): void {
  const allowedMethodsString = allowedMethods.join(', ');

  const disallowedMethods = HTTP_METHODS.filter(
    (m) => !allowedMethods.includes(m) && m !== 'OPTIONS',
  );
  test.each(disallowedMethods)('%s requests should be refused', async (method) => {
    const fastify = await initFastify();

    const response = await fastify.inject({ method, url: endpointURL });

    expect(response).toHaveProperty('statusCode', 405);
    expect(response).toHaveProperty('headers.allow', allowedMethodsString);
  });

  test('OPTIONS requests should list the allowed methods', async () => {
    const fastify = await initFastify();

    const response = await fastify.inject({ method: 'OPTIONS', url: endpointURL });

    expect(response).toHaveProperty('statusCode', 204);
    expect(response).toHaveProperty('headers.allow', allowedMethodsString);
  });
}

export function mockFastifyMongoose(mockMongoProperty: () => { readonly db: Connection }): void {
  const mockFastifyPlugin = fastifyPlugin;
  jest.mock('fastify-mongoose', () => {
    function mockFunc(fastify: FastifyInstance, _options: any, next: () => void): void {
      fastify.decorate('mongo', mockMongoProperty());
      next();
    }

    return mockFastifyPlugin(mockFunc, { name: 'fastify-mongoose' });
  });
}
