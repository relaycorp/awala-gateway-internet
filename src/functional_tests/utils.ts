import {
  Certificate,
  generateRSAKeyPair,
  issueDeliveryAuthorization,
  issueEndpointCertificate,
  issueGatewayCertificate,
} from '@relaycorp/relaynet-core';
import { S3 } from 'aws-sdk';
import { get as getEnvVar } from 'env-var';
import { connect as stanConnect, Stan } from 'node-nats-streaming';

import { initVaultKeyStore } from '../backingServices/privateKeyStore';

const TOMORROW = new Date();
TOMORROW.setDate(TOMORROW.getDate() + 1);

export const OBJECT_STORAGE_CLIENT = initS3Client();
export const OBJECT_STORAGE_BUCKET = getEnvVar('OBJECT_STORE_BUCKET')
  .required()
  .asString();

export async function sleep(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1_000));
}

export function initS3Client(): S3 {
  const endpoint = getEnvVar('OBJECT_STORE_ENDPOINT')
    .required()
    .asString();
  const accessKeyId = getEnvVar('OBJECT_STORE_ACCESS_KEY_ID')
    .required()
    .asString();
  const secretAccessKey = getEnvVar('OBJECT_STORE_SECRET_KEY')
    .required()
    .asString();
  return new S3({
    accessKeyId,
    endpoint,
    s3ForcePathStyle: true,
    secretAccessKey,
    signatureVersion: 'v4',
    sslEnabled: false,
  });
}

export function connectToNatsStreaming(): Promise<Stan> {
  return new Promise(resolve => {
    const stanConnection = stanConnect(
      getEnvVar('NATS_CLUSTER_ID')
        .required()
        .asString(),
      'functional-tests',
      {
        url: getEnvVar('NATS_SERVER_URL')
          .required()
          .asString(),
      },
    );
    stanConnection.on('connect', resolve);
  });
}

export async function generatePdaChain(): Promise<{
  readonly pda: Certificate;
  readonly privateGatewayCertificate: Certificate;
  readonly privateGatewayPrivateKey: CryptoKey;
  readonly peerEndpointCertificate: Certificate;
  readonly privateKey: CryptoKey;
  readonly chain: readonly Certificate[];
}> {
  const privateKeyStore = initVaultKeyStore();
  const publicGatewayKeyId = Buffer.from(
    getEnvVar('GATEWAY_KEY_ID')
      .required()
      .asString(),
    'base64',
  );
  const publicGatewayKeyPair = await privateKeyStore.fetchNodeKey(publicGatewayKeyId);

  const privateGatewayKeyPair = await generateRSAKeyPair();
  const privateGatewayCertificate = await issueGatewayCertificate({
    issuerCertificate: publicGatewayKeyPair.certificate,
    issuerPrivateKey: publicGatewayKeyPair.privateKey,
    subjectPublicKey: privateGatewayKeyPair.publicKey,
    validityEndDate: TOMORROW,
  });

  const peerEndpointKeyPair = await generateRSAKeyPair();
  const peerEndpointCertificate = await issueEndpointCertificate({
    issuerCertificate: privateGatewayCertificate,
    issuerPrivateKey: privateGatewayKeyPair.privateKey,
    subjectPublicKey: peerEndpointKeyPair.publicKey,
    validityEndDate: TOMORROW,
  });

  const pdaGranteeKeyPair = await generateRSAKeyPair();
  const pda = await issueDeliveryAuthorization({
    issuerCertificate: peerEndpointCertificate,
    issuerPrivateKey: peerEndpointKeyPair.privateKey,
    subjectPublicKey: pdaGranteeKeyPair.publicKey,
    validityEndDate: TOMORROW,
  });

  return {
    chain: [privateGatewayCertificate, peerEndpointCertificate],
    pda,
    peerEndpointCertificate,
    privateGatewayCertificate,
    privateGatewayPrivateKey: privateGatewayKeyPair.privateKey,
    privateKey: pdaGranteeKeyPair.privateKey,
  };
}
