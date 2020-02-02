/* tslint:disable:no-let */

import {
  Certificate,
  generateRSAKeyPair,
  issueDeliveryAuthorization,
  issueEndpointCertificate,
  issueGatewayCertificate,
  Parcel,
} from '@relaycorp/relaynet-core';
import envVar from 'env-var';

const TOMORROW = new Date();
TOMORROW.setDate(TOMORROW.getDate() + 1);

export function getMockContext(mockedObject: any): jest.MockContext<any, any> {
  const mockInstance = (mockedObject as unknown) as jest.MockInstance<any, any>;
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

  beforeEach(() => setEnvVars(envVars));

  afterAll(() => {
    mockEnvVarGet.mockRestore();
  });

  return (newEnvVars: EnvVarSet) => setEnvVars(newEnvVars);
}

export interface PdaChain {
  readonly relayingGateway: Certificate;
  readonly localGateway: Certificate;
  readonly peerEndpoint: Certificate;
  readonly pda: Certificate;
  readonly pdaGranteePrivateKey: CryptoKey;
}

export async function generateStubPdaChain(): Promise<PdaChain> {
  const relayingGatewayKeyPair = await generateRSAKeyPair();
  const relayingGatewayCert = await issueGatewayCertificate({
    issuerPrivateKey: relayingGatewayKeyPair.privateKey,
    subjectPublicKey: relayingGatewayKeyPair.publicKey,
    validityEndDate: TOMORROW,
  });

  const localGatewayKeyPair = await generateRSAKeyPair();
  const localGatewayCert = await issueGatewayCertificate({
    issuerCertificate: relayingGatewayCert,
    issuerPrivateKey: relayingGatewayKeyPair.privateKey,
    subjectPublicKey: localGatewayKeyPair.publicKey,
    validityEndDate: TOMORROW,
  });

  const peerEndpointKeyPair = await generateRSAKeyPair();
  const peerEndpointCert = await issueEndpointCertificate({
    issuerCertificate: localGatewayCert,
    issuerPrivateKey: localGatewayKeyPair.privateKey,
    subjectPublicKey: peerEndpointKeyPair.publicKey,
    validityEndDate: TOMORROW,
  });

  const endpointKeyPair = await generateRSAKeyPair();
  const endpointPdaCert = await issueDeliveryAuthorization({
    issuerCertificate: peerEndpointCert,
    issuerPrivateKey: peerEndpointKeyPair.privateKey,
    subjectPublicKey: endpointKeyPair.publicKey,
    validityEndDate: TOMORROW,
  });

  return {
    localGateway: localGatewayCert,
    pda: endpointPdaCert,
    pdaGranteePrivateKey: endpointKeyPair.privateKey,
    peerEndpoint: peerEndpointCert,
    relayingGateway: relayingGatewayCert,
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
  readonly senderPrivateKey: CryptoKey;
}

export async function generateStubParcel(options: StubParcelOptions): Promise<Buffer> {
  const parcel = new Parcel(
    options.recipientAddress,
    options.senderCertificate,
    Buffer.from('the payload'),
    { senderCaCertificateChain: options.senderCertificateChain ?? [] },
  );
  return Buffer.from(await parcel.serialize(options.senderPrivateKey));
}

export function expectBuffersToEqual(
  buffer1: Buffer | ArrayBuffer,
  buffer2: Buffer | ArrayBuffer,
): void {
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
