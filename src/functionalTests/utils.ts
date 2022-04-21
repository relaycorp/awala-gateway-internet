import { initObjectStoreClient, ObjectStoreClient } from '@relaycorp/object-storage';
import {
  generateRSAKeyPair,
  issueDeliveryAuthorization,
  issueEndpointCertificate,
  PrivateNodeRegistration,
  PrivateNodeRegistrationRequest,
  SessionKey,
} from '@relaycorp/relaynet-core';
import { PoWebClient } from '@relaycorp/relaynet-poweb';
import { get as getEnvVar } from 'env-var';
import { connect as stanConnect, Stan } from 'node-nats-streaming';
import uuid from 'uuid-random';

import { ExternalPdaChain } from '../testUtils/pki';
import { GW_POWEB_LOCAL_PORT } from './services';

export const IS_GITHUB = getEnvVar('IS_GITHUB').asBool();

export const OBJECT_STORAGE_CLIENT = initObjectStoreClientFromEnv();
export const OBJECT_STORAGE_BUCKET = getEnvVar('OBJECT_STORE_BUCKET').required().asString();

export async function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
}

function initObjectStoreClientFromEnv(): ObjectStoreClient {
  const endpoint = getEnvVar('OBJECT_STORE_ENDPOINT').required().asString();
  const accessKeyId = getEnvVar('OBJECT_STORE_ACCESS_KEY_ID').required().asString();
  const secretAccessKey = getEnvVar('OBJECT_STORE_SECRET_KEY').required().asString();
  return initObjectStoreClient('minio', endpoint, accessKeyId, secretAccessKey, false);
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

export interface PrivateGatewayRegistration {
  readonly pdaChain: ExternalPdaChain;
  readonly publicGatewaySessionKey: SessionKey;
}

export async function createAndRegisterPrivateGateway(): Promise<PrivateGatewayRegistration> {
  const privateGatewayKeyPair = await generateRSAKeyPair();
  const {
    privateNodeCertificate: privateGatewayCertificate,
    gatewayCertificate: publicGatewayCert,
    sessionKey: publicGatewaySessionKey,
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

  const pdaChain = {
    pdaCert: pda,
    pdaGranteePrivateKey: pdaGranteeKeyPair.privateKey,
    peerEndpointCert: peerEndpointCertificate,
    peerEndpointPrivateKey: peerEndpointKeyPair.privateKey,
    privateGatewayCert: privateGatewayCertificate,
    privateGatewayPrivateKey: privateGatewayKeyPair.privateKey,
    publicGatewayCert,
  };
  return { pdaChain, publicGatewaySessionKey: publicGatewaySessionKey!! };
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
