import {
  Certificate,
  generateRSAKeyPair,
  issueDeliveryAuthorization,
  issueEndpointCertificate,
  issueGatewayCertificate,
  Parcel,
} from '@relaycorp/relaynet-core';
import envVar from 'env-var';
import { FastifyInstance, HTTPMethods } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { Connection } from 'mongoose';
import * as stan from 'node-nats-streaming';

import { PdaChain } from '../_test_utils';
import { HTTP_METHODS } from './fastify';

export const TOMORROW = new Date();
TOMORROW.setDate(TOMORROW.getDate() + 1);

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

export async function generatePdaChain(): Promise<PdaChain> {
  const publicGatewayKeyPair = await generateRSAKeyPair();
  const publicGatewayCert = reSerializeCertificate(
    await issueGatewayCertificate({
      issuerPrivateKey: publicGatewayKeyPair.privateKey,
      subjectPublicKey: publicGatewayKeyPair.publicKey,
      validityEndDate: TOMORROW,
    }),
  );

  const privateGatewayKeyPair = await generateRSAKeyPair();
  const privateGatewayCert = reSerializeCertificate(
    await issueGatewayCertificate({
      issuerCertificate: publicGatewayCert,
      issuerPrivateKey: publicGatewayKeyPair.privateKey,
      subjectPublicKey: privateGatewayKeyPair.publicKey,
      validityEndDate: TOMORROW,
    }),
  );

  const peerEndpointKeyPair = await generateRSAKeyPair();
  const peerEndpointCert = reSerializeCertificate(
    await issueEndpointCertificate({
      issuerCertificate: privateGatewayCert,
      issuerPrivateKey: privateGatewayKeyPair.privateKey,
      subjectPublicKey: peerEndpointKeyPair.publicKey,
      validityEndDate: TOMORROW,
    }),
  );

  const endpointKeyPair = await generateRSAKeyPair();
  const endpointPdaCert = reSerializeCertificate(
    await issueDeliveryAuthorization({
      issuerCertificate: peerEndpointCert,
      issuerPrivateKey: peerEndpointKeyPair.privateKey,
      subjectPublicKey: endpointKeyPair.publicKey,
      validityEndDate: TOMORROW,
    }),
  );

  return {
    pdaCert: endpointPdaCert,
    pdaGranteePrivateKey: endpointKeyPair.privateKey,
    peerEndpointCert,
    peerEndpointPrivateKey: peerEndpointKeyPair.privateKey,
    privateGatewayCert,
    privateGatewayPrivateKey: privateGatewayKeyPair.privateKey,
    publicGatewayCert,
    publicGatewayPrivateKey: publicGatewayKeyPair.privateKey,
  };
}

export async function generateStubEndpointCertificate(
  keyPair: CryptoKeyPair,
): Promise<Certificate> {
  return issueEndpointCertificate({
    issuerPrivateKey: keyPair.privateKey,
    subjectPublicKey: keyPair.publicKey,
    validityEndDate: TOMORROW,
  });
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

export function expectBuffersToEqual<T extends Buffer | ArrayBuffer>(buffer1: T, buffer2: T): void {
  if (buffer1 instanceof Buffer) {
    expect(buffer2).toBeInstanceOf(Buffer);
    expect(buffer1.equals(buffer2 as Buffer)).toBeTrue();
  } else {
    expect(buffer1).toBeInstanceOf(ArrayBuffer);
    expect(buffer2).toBeInstanceOf(ArrayBuffer);

    const actualBuffer1 = Buffer.from(buffer1);
    const actualBuffer2 = Buffer.from(buffer2);
    expect(actualBuffer1.equals(actualBuffer2)).toBeTrue();
  }
}

export function reSerializeCertificate(cert: Certificate): Certificate {
  // TODO: Raise bug in PKI.js project
  // PKI.js sometimes tries to use attributes that are only set *after* the certificate has been
  // deserialized, so you'd get a TypeError if you use a certificate you just created in memory.
  // For example, `extension.parsedValue` would be `undefined` in
  // https://github.com/PeculiarVentures/PKI.js/blob/9a39551aa9f1445406f96680318014c8d714e8e3/src/CertificateChainValidationEngine.js#L155
  return Certificate.deserialize(cert.serialize());
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

export function mockFastifyMongoose(mockMongoProperty: { readonly db: Connection }): void {
  const mockFastifyPlugin = fastifyPlugin;
  jest.mock('fastify-mongoose', () => {
    function mockFunc(fastify: FastifyInstance, _options: any, next: () => void): void {
      fastify.decorate('mongo', mockMongoProperty);
      next();
    }

    return mockFastifyPlugin(mockFunc, { name: 'fastify-mongoose' });
  });
}
