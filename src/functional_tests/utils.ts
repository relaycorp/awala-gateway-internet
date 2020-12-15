import {
  Certificate,
  generateRSAKeyPair,
  issueDeliveryAuthorization,
  issueEndpointCertificate,
  PrivateNodeRegistration,
  PrivateNodeRegistrationRequest,
  UnboundKeyPair,
} from '@relaycorp/relaynet-core';
import { PoWebClient } from '@relaycorp/relaynet-poweb';
import { S3 } from 'aws-sdk';
import { get as getEnvVar } from 'env-var';
import { connect as stanConnect, Stan } from 'node-nats-streaming';
import uuid from 'uuid-random';

import { ExternalPdaChain } from '../_test_utils';
import { initVaultKeyStore } from '../backingServices/privateKeyStore';
import { GW_POWEB_LOCAL_PORT } from './services';

export const IS_GITHUB = getEnvVar('IS_GITHUB').asBool();

export const OBJECT_STORAGE_CLIENT = initS3Client();
export const OBJECT_STORAGE_BUCKET = getEnvVar('OBJECT_STORE_BUCKET').required().asString();

export async function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
}

function initS3Client(): S3 {
  const endpoint = getEnvVar('OBJECT_STORE_ENDPOINT').required().asString();
  const accessKeyId = getEnvVar('OBJECT_STORE_ACCESS_KEY_ID').required().asString();
  const secretAccessKey = getEnvVar('OBJECT_STORE_SECRET_KEY').required().asString();
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
  return new Promise((resolve) => {
    const stanConnection = stanConnect(
      getEnvVar('NATS_CLUSTER_ID').required().asString(),
      `functional-tests-${uuid()}`,
      {
        url: getEnvVar('NATS_SERVER_URL').required().asString(),
      },
    );
    stanConnection.on('connect', resolve);
  });
}

async function getPublicGatewayKeyPair(): Promise<UnboundKeyPair> {
  const privateKeyStore = initVaultKeyStore();
  const publicGatewayKeyId = Buffer.from(
    getEnvVar('GATEWAY_KEY_ID').required().asString(),
    'base64',
  );
  return privateKeyStore.fetchNodeKey(publicGatewayKeyId);
}

export async function getPublicGatewayCertificate(): Promise<Certificate> {
  const keyPair = await getPublicGatewayKeyPair();
  return keyPair.certificate;
}

export async function generatePdaChain(): Promise<ExternalPdaChain> {
  const privateGatewayKeyPair = await generateRSAKeyPair();
  const {
    privateNodeCertificate: privateGatewayCertificate,
    gatewayCertificate: publicGatewayCert,
  } = await registerPrivateGateway(
    privateGatewayKeyPair,
    PoWebClient.initLocal(GW_POWEB_LOCAL_PORT),
  );

  const peerEndpointKeyPair = await generateRSAKeyPair();
  const peerEndpointCertificate = await issueEndpointCertificate({
    issuerCertificate: privateGatewayCertificate,
    issuerPrivateKey: privateGatewayKeyPair.privateKey,
    subjectPublicKey: peerEndpointKeyPair.publicKey,
    validityEndDate: privateGatewayCertificate.expiryDate,
  });

  const pdaGranteeKeyPair = await generateRSAKeyPair();
  const pda = await issueDeliveryAuthorization({
    issuerCertificate: peerEndpointCertificate,
    issuerPrivateKey: peerEndpointKeyPair.privateKey,
    subjectPublicKey: pdaGranteeKeyPair.publicKey,
    validityEndDate: peerEndpointCertificate.expiryDate,
  });

  return {
    pdaCert: pda,
    pdaGranteePrivateKey: pdaGranteeKeyPair.privateKey,
    peerEndpointCert: peerEndpointCertificate,
    peerEndpointPrivateKey: peerEndpointKeyPair.privateKey,
    privateGatewayCert: privateGatewayCertificate,
    privateGatewayPrivateKey: privateGatewayKeyPair.privateKey,
    publicGatewayCert,
  };
}

export async function registerPrivateGateway(
  privateGatewayKeyPair: CryptoKeyPair,
  client: PoWebClient,
): Promise<PrivateNodeRegistration> {
  const authorizationSerialized = await client.preRegisterNode(privateGatewayKeyPair.publicKey);
  const registrationRequest = new PrivateNodeRegistrationRequest(
    privateGatewayKeyPair.publicKey,
    authorizationSerialized,
  );
  return client.registerNode(await registrationRequest.serialize(privateGatewayKeyPair.privateKey));
}

export function* arrayToIterable<T>(array: readonly T[]): IterableIterator<T> {
  for (const item of array) {
    yield item;
  }
}
