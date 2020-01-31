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

export function mockEnvVars(envVars: { readonly [key: string]: string | undefined }): void {
  jest.spyOn(envVar, 'get').mockImplementation((...args: readonly any[]) => {
    const originalEnvVar = jest.requireActual('env-var');
    const env = originalEnvVar.from(envVars);

    return env.get(...args);
  });
}

export function restoreEnvVars(): void {
  // @ts-ignore
  envVar.get.mockRestore();
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

export async function generateStubEndpointCertificate(): Promise<Certificate> {
  const keyPair = await generateRSAKeyPair();
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
