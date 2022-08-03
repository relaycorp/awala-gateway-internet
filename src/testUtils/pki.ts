import {
  CargoCollectionAuthorization,
  CargoCollectionRequest,
  Certificate,
  generateRSAKeyPair,
  issueDeliveryAuthorization,
  issueEndpointCertificate,
  issueGatewayCertificate,
  Recipient,
  SessionEnvelopedData,
  SessionKey,
} from '@relaycorp/relaynet-core';
import { addDays } from 'date-fns';

import { CERTIFICATE_TTL_DAYS } from '../pki';

const TOMORROW = addDays(new Date(), 1);

export interface CDAChain {
  readonly publicGatewayCert: Certificate;
  readonly privateGatewayCert: Certificate;
}

export interface ExternalPdaChain extends CDAChain {
  readonly privateGatewayPrivateKey: CryptoKey;
  readonly peerEndpointCert: Certificate;
  readonly peerEndpointPrivateKey: CryptoKey;
  readonly pdaCert: Certificate;
  readonly pdaGranteePrivateKey: CryptoKey;
}

export interface PdaChain extends ExternalPdaChain {
  readonly publicGatewayPrivateKey: CryptoKey;
}

// TODO: Replace with respective function in @relaycorp/relaynet-testing
export async function generatePdaChain(): Promise<PdaChain> {
  const publicGatewayKeyPair = await generateRSAKeyPair();
  const publicGatewayCert = reSerializeCertificate(
    await issueGatewayCertificate({
      issuerPrivateKey: publicGatewayKeyPair.privateKey,
      subjectPublicKey: publicGatewayKeyPair.publicKey,
      validityEndDate: addDays(new Date(), CERTIFICATE_TTL_DAYS),
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

export function reSerializeCertificate(cert: Certificate): Certificate {
  // TODO: Raise bug in PKI.js project
  // PKI.js sometimes tries to use attributes that are only set *after* the certificate has been
  // deserialized, so you'd get a TypeError if you use a certificate you just created in memory.
  // For example, `extension.parsedValue` would be `undefined` in
  // https://github.com/PeculiarVentures/PKI.js/blob/9a39551aa9f1445406f96680318014c8d714e8e3/src/CertificateChainValidationEngine.js#L155
  return Certificate.deserialize(cert.serialize());
}

// TODO: Replace with respective function in @relaycorp/relaynet-testing
export async function generateCDAChain(pdaChain: ExternalPdaChain): Promise<CDAChain> {
  const privateGatewayCert = reSerializeCertificate(
    await issueGatewayCertificate({
      issuerPrivateKey: pdaChain.privateGatewayPrivateKey,
      subjectPublicKey: await pdaChain.privateGatewayCert.getPublicKey(),
      validityEndDate: pdaChain.privateGatewayCert.expiryDate,
    }),
  );
  const publicGatewayCert = reSerializeCertificate(
    await issueDeliveryAuthorization({
      issuerCertificate: privateGatewayCert,
      issuerPrivateKey: pdaChain.privateGatewayPrivateKey,
      subjectPublicKey: await pdaChain.publicGatewayCert.getPublicKey(),
      validityEndDate: pdaChain.publicGatewayCert.expiryDate,
    }),
  );
  return { privateGatewayCert, publicGatewayCert };
}

export interface GeneratedCCA {
  readonly cca: CargoCollectionAuthorization;
  readonly ccaSerialized: Buffer;
  readonly sessionPrivateKey: CryptoKey;
}

export async function generateCCA(
  publicGatewayRecipient: Recipient,
  publicGatewaySessionKey: SessionKey,
  publicGatewayCDA: Certificate,
  privateGatewayCertificate: Certificate,
  privateGatewayPrivateKey: CryptoKey,
): Promise<GeneratedCCA> {
  const ccr = new CargoCollectionRequest(publicGatewayCDA);
  const { envelopedData, dhPrivateKey } = await SessionEnvelopedData.encrypt(
    ccr.serialize(),
    publicGatewaySessionKey,
  );
  const cca = new CargoCollectionAuthorization(
    publicGatewayRecipient,
    privateGatewayCertificate,
    Buffer.from(envelopedData.serialize()),
  );
  const ccaSerialized = await cca.serialize(privateGatewayPrivateKey);
  return { cca, ccaSerialized: Buffer.from(ccaSerialized), sessionPrivateKey: dhPrivateKey };
}
