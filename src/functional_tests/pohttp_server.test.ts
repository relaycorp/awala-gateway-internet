import {
  Certificate,
  generateRSAKeyPair,
  issueDeliveryAuthorization,
  issueEndpointCertificate,
  issueGatewayCertificate,
  Parcel,
} from '@relaycorp/relaynet-core';
import { deliverParcel, PoHTTPError } from '@relaycorp/relaynet-pohttp';
import { S3 } from 'aws-sdk';
import { AxiosError } from 'axios';
import * as dockerCompose from 'docker-compose';
import * as dotEnv from 'dotenv';
import { get as getEnvVar } from 'env-var';

import { initVaultKeyStore } from '../backingServices/privateKeyStore';
import { sleep } from './utils';

dotEnv.config();
process.env.POHTTP_TLS_REQUIRED = 'false';
process.env.VAULT_URL = 'http://127.0.0.1:8200';
process.env.OBJECT_STORE_ENDPOINT = 'http://127.0.0.1:9000';

const TOMORROW = new Date();
TOMORROW.setDate(TOMORROW.getDate() + 1);

const GW_POHTTP_URL = 'http://127.0.0.1:8080';

describe('PoHTTP server', () => {
  beforeAll(async () => {
    jest.setTimeout(20_000);
    await tearDownServices();
    await setUpServices();
    await setUpGateway();
  });
  afterAll(tearDownServices);

  test('Valid parcel should be accepted', async () => {
    const pdaChain = await generatePdaChain();
    const parcel = new Parcel(
      await pdaChain.peerEndpointCertificate.calculateSubjectPrivateAddress(),
      pdaChain.pda,
      Buffer.from([]),
      { senderCaCertificateChain: pdaChain.chain },
    );
    const parcelSerialized = await parcel.serialize(pdaChain.privateKey);

    await expect(deliverParcel(GW_POHTTP_URL, parcelSerialized)).toResolve();

    // TODO: Check that parcel was actually stored
  });

  test('Unauthorized parcel should be refused', async () => {
    const senderKeyPair = await generateRSAKeyPair();
    const senderCertificate = await issueEndpointCertificate({
      issuerPrivateKey: senderKeyPair.privateKey,
      subjectPublicKey: senderKeyPair.publicKey,
      validityEndDate: TOMORROW,
    });

    const parcel = new Parcel('0deadbeef', senderCertificate, Buffer.from([]));

    await expect(
      deliverParcel(GW_POHTTP_URL, await parcel.serialize(senderKeyPair.privateKey)),
    ).rejects.toSatisfy((err: PoHTTPError) => {
      const response = (err.cause() as AxiosError).response;
      return (
        response!.status === 400 && response!.data.message === 'Parcel sender is not authorized'
      );
    });
  });
});

async function setUpServices(): Promise<void> {
  await dockerCompose.upAll({ log: true });
  await sleep(2);

  // Configure Vault
  await dockerCompose.exec('vault', ['vault', 'secrets', 'enable', '-path=gw-keys', 'kv-v2'], {
    commandOptions: ['--env', 'VAULT_ADDR=http://127.0.0.1:8200', '--env', 'VAULT_TOKEN=letmein'],
    log: true,
  });

  await configureMinio();
}

async function configureMinio(): Promise<void> {
  const endpoint = getEnvVar('OBJECT_STORE_ENDPOINT')
    .required()
    .asString();
  const s3Cient = new S3({
    accessKeyId: getEnvVar('OBJECT_STORE_ACCESS_KEY_ID')
      .required()
      .asString(),
    endpoint,
    s3ForcePathStyle: true,
    secretAccessKey: getEnvVar('OBJECT_STORE_SECRET_KEY')
      .required()
      .asString(),
    signatureVersion: 'v4',
    sslEnabled: false,
  });
  await s3Cient
    .createBucket({
      Bucket: getEnvVar('OBJECT_STORE_BUCKET')
        .required()
        .asString(),
    })
    .promise();
}

async function tearDownServices(): Promise<void> {
  await dockerCompose.down({ commandOptions: ['--remove-orphans'], log: true });
}

async function setUpGateway(): Promise<void> {
  await dockerCompose.exec('cogrpc', ['ts-node-dev', 'src/bin/generate-keypairs.ts']);
}

async function generatePdaChain(): Promise<{
  readonly pda: Certificate;
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
    privateKey: pdaGranteeKeyPair.privateKey,
  };
}
