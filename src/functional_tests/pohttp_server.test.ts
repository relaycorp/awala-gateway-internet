import {
  Certificate,
  generateRSAKeyPair,
  issueDeliveryAuthorization,
  issueEndpointCertificate,
  issueGatewayCertificate,
  Parcel,
} from '@relaycorp/relaynet-core';
import { deliverParcel, PoHTTPError } from '@relaycorp/relaynet-pohttp';
import { AxiosError } from 'axios';
import * as dockerCompose from 'docker-compose';
import * as dotEnv from 'dotenv';
import { get as getEnvVar } from 'env-var';
import { connect as stanConnect, Message, Stan } from 'node-nats-streaming';

import { initVaultKeyStore } from '../backingServices/privateKeyStore';
import { initS3Client, sleep } from './utils';

dotEnv.config();
Object.assign(process.env, {
  NATS_SERVER_URL: 'nats://127.0.0.1:4222',
  OBJECT_STORE_ENDPOINT: 'http://127.0.0.1:9000',
  POHTTP_TLS_REQUIRED: 'false',
  VAULT_URL: 'http://127.0.0.1:8200',
});

const TOMORROW = new Date();
TOMORROW.setDate(TOMORROW.getDate() + 1);

const GW_POHTTP_URL = 'http://127.0.0.1:8080';

const OBJECT_STORAGE_CLIENT = initS3Client();
const OBJECT_STORAGE_BUCKET = getEnvVar('OBJECT_STORE_BUCKET')
  .required()
  .asString();

describe('PoHTTP server', () => {
  beforeAll(async () => {
    jest.setTimeout(15_000);
    await tearDownServices();
    await dockerCompose.upAll({ log: true });
    await sleep(2);
    await bootstrapData();
  });
  afterAll(tearDownServices);

  // tslint:disable-next-line:no-let
  let stanConnection: Stan;
  beforeAll(
    async () =>
      new Promise(resolve => {
        stanConnection = stanConnect(
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
      }),
  );
  afterAll(async () => stanConnection.close());

  test('Valid parcel should be accepted', async cb => {
    const pdaChain = await generatePdaChain();
    const parcel = new Parcel(
      await pdaChain.peerEndpointCertificate.calculateSubjectPrivateAddress(),
      pdaChain.pda,
      Buffer.from([]),
      { senderCaCertificateChain: pdaChain.chain },
    );
    const parcelSerialized = Buffer.from(await parcel.serialize(pdaChain.privateKey));

    // We should get a successful response
    await expect(deliverParcel(GW_POHTTP_URL, parcelSerialized)).toResolve();

    // The parcel should've been safely stored
    const subscription = stanConnection.subscribe(
      `pdc-parcel.${await pdaChain.privateGatewayCertificate.calculateSubjectPrivateAddress()}`,
      'functional-tests',
      stanConnection.subscriptionOptions().setDeliverAllAvailable(),
    );
    subscription.on('error', cb);
    subscription.on('message', async (message: Message) => {
      const objectKey = message.getData() as string;
      await expect(
        OBJECT_STORAGE_CLIENT.getObject({
          Bucket: OBJECT_STORAGE_BUCKET,
          Key: objectKey,
        }).promise(),
      ).resolves.toMatchObject({ Body: parcelSerialized });
      cb();
    });
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

async function bootstrapData(): Promise<void> {
  // Configure Vault
  await dockerCompose.exec('vault', ['vault', 'secrets', 'enable', '-path=gw-keys', 'kv-v2'], {
    commandOptions: ['--env', 'VAULT_ADDR=http://127.0.0.1:8200', '--env', 'VAULT_TOKEN=letmein'],
    log: true,
  });

  await OBJECT_STORAGE_CLIENT.createBucket({
    Bucket: OBJECT_STORAGE_BUCKET,
  }).promise();

  await dockerCompose.exec('cogrpc', ['ts-node-dev', 'src/bin/generate-keypairs.ts']);
}

async function tearDownServices(): Promise<void> {
  await dockerCompose.down({ commandOptions: ['--remove-orphans'], log: true });
}

async function generatePdaChain(): Promise<{
  readonly pda: Certificate;
  readonly privateGatewayCertificate: Certificate;
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
    privateKey: pdaGranteeKeyPair.privateKey,
  };
}
