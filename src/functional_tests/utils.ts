import {
  generateRSAKeyPair,
  issueDeliveryAuthorization,
  issueEndpointCertificate,
  issueGatewayCertificate,
} from '@relaycorp/relaynet-core';
import { S3 } from 'aws-sdk';
import { get as getEnvVar } from 'env-var';
import { connect as stanConnect, Message, Stan } from 'node-nats-streaming';

import { PdaChain } from '../_test_utils';
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

function initS3Client(): S3 {
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

export async function getFirstQueueMessage(subject: string): Promise<Buffer | undefined> {
  const stanConnection = await connectToNatsStreaming();
  const subscription = stanConnection.subscribe(
    subject,
    'functional-tests',
    stanConnection.subscriptionOptions().setDeliverAllAvailable(),
  );
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.close();
      stanConnection.close();
      resolve();
    }, 3_000);
    subscription.on('error', error => {
      clearTimeout(timeout);
      subscription.close();
      stanConnection.close();
      reject(error);
    });
    subscription.on('message', (message: Message) => {
      clearTimeout(timeout);
      subscription.close();
      stanConnection.close();
      resolve(message.getRawData());
    });
  });
}

export async function generatePdaChain(): Promise<PdaChain> {
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
    pdaCert: pda,
    pdaGranteePrivateKey: pdaGranteeKeyPair.privateKey,
    peerEndpointCert: peerEndpointCertificate,
    peerEndpointPrivateKey: peerEndpointKeyPair.privateKey,
    privateGatewayCert: privateGatewayCertificate,
    privateGatewayPrivateKey: privateGatewayKeyPair.privateKey,
    publicGatewayCert: publicGatewayKeyPair.certificate,
    publicGatewayPrivateKey: publicGatewayKeyPair.privateKey,
  };
}
