/* tslint:disable:no-let */

import {
  Cargo,
  CargoMessageSet,
  Certificate,
  derSerializePublicKey,
  generateECDHKeyPair,
  issueInitialDHKeyCertificate,
  MockPrivateKeyStore,
  MockPublicKeyStore,
  Parcel,
  PrivateKeyStoreError,
  RAMFSyntaxError,
  SessionEnvelopedData,
  SessionlessEnvelopedData,
  SessionPublicKeyData,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import * as stan from 'node-nats-streaming';

import { mockPino, mockSpy } from '../_test_utils';
import * as mongo from '../backingServices/mongo';
import { NatsStreamingClient, PublisherMessage } from '../backingServices/natsStreaming';
import * as privateKeyStore from '../backingServices/privateKeyStore';
import {
  castMock,
  configureMockEnvVars,
  generateStubPdaChain,
  mockStanMessage,
  PdaChain,
} from './_test_utils';
import * as mongoPublicKeyStore from './MongoPublicKeyStore';

const mockLogger = mockPino();
import { processIncomingCrcCargo } from './crcQueueWorker';

//region Stan-related fixtures

const STUB_NATS_SERVER = 'nats://example.com';
const STUB_NATS_CLUSTER_ID = 'nats-cluster-id';
const STUB_WORKER_NAME = 'worker-name';

let mockNatsClient: NatsStreamingClient;
let mockQueueMessages: readonly stan.Message[];
// tslint:disable-next-line:readonly-array
let mockPublishedMessages: Buffer[];
beforeEach(() => {
  mockQueueMessages = [];
  mockPublishedMessages = [];

  async function* mockMakePublisher(
    messages: AsyncIterable<PublisherMessage>,
  ): AsyncIterable<string> {
    for await (const message of messages) {
      mockPublishedMessages.push(message.data as Buffer);
      yield message.id;
    }
  }

  async function* mockMakeQueueConsumer(): AsyncIterable<stan.Message> {
    for (const message of mockQueueMessages) {
      yield message;
    }
  }

  mockNatsClient = castMock<NatsStreamingClient>({
    disconnect: jest.fn(),
    makePublisher: jest.fn().mockReturnValue(mockMakePublisher),
    makeQueueConsumer: jest.fn().mockImplementation(mockMakeQueueConsumer),
  });
});
mockSpy(jest.spyOn(NatsStreamingClient, 'initFromEnv'), () => mockNatsClient);

//region Keystore-related fixtures

const STUB_VAULT_URL = 'https://vault.com';
const STUB_VAULT_TOKEN = 'letmein';
const STUB_VAULT_KV_PREFIX = 'keys/';

let mockPrivateKeyStore: MockPrivateKeyStore;
let mockPublicKeyStore: MockPublicKeyStore;
beforeEach(() => {
  mockPrivateKeyStore = new MockPrivateKeyStore();
  mockPublicKeyStore = new MockPublicKeyStore();
});
mockSpy(jest.spyOn(privateKeyStore, 'initVaultKeyStore'), () => mockPrivateKeyStore);
mockSpy(jest.spyOn(mongo, 'createMongooseConnectionFromEnv'), () => ({
  what: 'mongooseConnection',
}));
mockSpy(jest.spyOn(mongoPublicKeyStore, 'MongoPublicKeyStore'), () => mockPublicKeyStore);

//endregion

const BASE_ENV_VARS = {
  NATS_CLUSTER_ID: STUB_NATS_CLUSTER_ID,
  NATS_SERVER_URL: STUB_NATS_SERVER,
  VAULT_KV_PREFIX: STUB_VAULT_KV_PREFIX,
  VAULT_TOKEN: STUB_VAULT_TOKEN,
  VAULT_URL: STUB_VAULT_URL,
};
configureMockEnvVars(BASE_ENV_VARS);

let stubPdaChain: PdaChain;
let PUBLIC_GW_SESSION_KEY_PAIR: CryptoKeyPair;
let PUBLIC_GW_SESSION_CERT: Certificate;
beforeAll(async () => {
  stubPdaChain = await generateStubPdaChain();

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  PUBLIC_GW_SESSION_KEY_PAIR = await generateECDHKeyPair();
  PUBLIC_GW_SESSION_CERT = await issueInitialDHKeyCertificate({
    issuerCertificate: stubPdaChain.publicGatewayCert,
    issuerPrivateKey: stubPdaChain.publicGatewayPrivateKey,
    subjectPublicKey: PUBLIC_GW_SESSION_KEY_PAIR.publicKey,
    validityEndDate: tomorrow,
  });
});

beforeEach(async () => {
  await mockPrivateKeyStore.registerNodeKey(
    stubPdaChain.publicGatewayPrivateKey,
    stubPdaChain.publicGatewayCert,
  );
  await mockPrivateKeyStore.registerInitialSessionKey(
    PUBLIC_GW_SESSION_KEY_PAIR.privateKey,
    PUBLIC_GW_SESSION_CERT,
  );
});

describe('Queue subscription', () => {
  test('Worker should subscribe to channel "crc-cargo"', async () => {
    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(mockNatsClient.makeQueueConsumer).toBeCalledWith(
      'crc-cargo',
      expect.anything(),
      expect.anything(),
    );
  });

  test('Subscription should use queue "worker"', async () => {
    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(mockNatsClient.makeQueueConsumer).toBeCalledWith(
      expect.anything(),
      'worker',
      expect.anything(),
    );
  });

  test('Subscription should use durable name "worker"', async () => {
    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(mockNatsClient.makeQueueConsumer).toBeCalledWith(
      expect.anything(),
      expect.anything(),
      'worker',
    );
  });
});

test('Cargo with invalid payload should be logged and ignored', async () => {
  const cargo = new Cargo(
    await stubPdaChain.publicGatewayCert.getCommonName(),
    stubPdaChain.privateGatewayCert,
    Buffer.from('Not a CMS EnvelopedData value'),
  );
  const cargoSerialized = await cargo.serialize(stubPdaChain.privateGatewayPrivateKey);

  const stanMessage = mockStanMessage(cargoSerialized);
  mockQueueMessages = [stanMessage];

  await processIncomingCrcCargo(STUB_WORKER_NAME);

  expect(mockLogger.info).toBeCalledWith(
    {
      cargoId: cargo.id,
      err: expect.objectContaining({ message: expect.stringMatching(/Could not deserialize/) }),
      senderAddress: await cargo.senderCertificate.calculateSubjectPrivateAddress(),
      worker: STUB_WORKER_NAME,
    },
    `Cargo payload is invalid`,
  );

  expect(stanMessage.ack).toBeCalledTimes(1);
});

test('Cargo failing to be unwrapped due to keystore errors should remain in queue', async () => {
  const cargo = await generateCargo();
  const stanMessage = mockStanMessage(await cargo.serialize(stubPdaChain.privateGatewayPrivateKey));
  mockQueueMessages = [stanMessage];

  // Mimic a downtime in Vault
  mockPrivateKeyStore = new MockPrivateKeyStore(false, true);

  await processIncomingCrcCargo(STUB_WORKER_NAME);

  expect(mockLogger.error).toBeCalledWith(
    {
      cargoId: cargo.id,
      err: expect.any(PrivateKeyStoreError),
      senderAddress: await stubPdaChain.privateGatewayCert.calculateSubjectPrivateAddress(),
      worker: STUB_WORKER_NAME,
    },
    'Failed to retrieve key from Vault',
  );

  expect(stanMessage.ack).not.toBeCalled();
});

test('Session keys of sender should be stored if present', async () => {
  const cargoMessageSet = new CargoMessageSet(new Set([]));
  const { envelopedData } = await SessionEnvelopedData.encrypt(
    cargoMessageSet.serialize(),
    PUBLIC_GW_SESSION_CERT,
  );
  const cargo = new Cargo(
    await stubPdaChain.publicGatewayCert.getCommonName(),
    stubPdaChain.privateGatewayCert,
    Buffer.from(envelopedData.serialize()),
  );
  const stanMessage = mockStanMessage(await cargo.serialize(stubPdaChain.privateGatewayPrivateKey));
  mockQueueMessages = [stanMessage];

  await processIncomingCrcCargo(STUB_WORKER_NAME);

  const originatorSessionKey = await envelopedData.getOriginatorKey();
  const expectedPublicKeyTime = new Date(cargo.creationDate);
  expectedPublicKeyTime.setMilliseconds(0);
  const expectedStoredKeyData: SessionPublicKeyData = {
    publicKeyCreationTime: expectedPublicKeyTime,
    publicKeyDer: await derSerializePublicKey(originatorSessionKey.publicKey),
    publicKeyId: originatorSessionKey.keyId,
  };
  await expect(mockPublicKeyStore.keys).toHaveProperty(
    await cargo.senderCertificate.calculateSubjectPrivateAddress(),
    expectedStoredKeyData,
  );
});

test('Parcels contained in cargo should be published on channel "crc-parcels"', async () => {
  const stubParcel = new Parcel('recipient-address', stubPdaChain.pdaCert, Buffer.from('hi'));
  const stubParcelSerialized = await stubParcel.serialize(stubPdaChain.pdaGranteePrivateKey);
  mockQueueMessages = [mockStanMessage(await generateCargoSerialized(stubParcelSerialized))];

  await processIncomingCrcCargo(STUB_WORKER_NAME);

  expect(mockNatsClient.makePublisher).toBeCalledTimes(1);
  expect(mockNatsClient.makePublisher).toBeCalledWith('crc-parcels');
  expect(mockPublishedMessages.map(bufferToArray)).toEqual([stubParcelSerialized]);
});

test('Cargo containing invalid messages should be logged and ignored', async () => {
  // First cargo contains an invalid messages followed by a valid. The second cargo contains
  // one message and it's valid.

  const stubParcel1 = new Parcel('recipient-address', stubPdaChain.pdaCert, Buffer.from('hi'));
  const stubParcel1Serialized = await stubParcel1.serialize(stubPdaChain.pdaGranteePrivateKey);
  const stubParcel2 = new Parcel('recipient-address', stubPdaChain.pdaCert, Buffer.from('hi'));
  const stubParcel2Serialized = await stubParcel2.serialize(stubPdaChain.pdaGranteePrivateKey);
  const stubCargo1Serialized = await generateCargoSerialized(
    Buffer.from('Not valid'),
    stubParcel1Serialized,
  );

  mockQueueMessages = [
    mockStanMessage(await stubCargo1Serialized),
    mockStanMessage(await generateCargoSerialized(stubParcel2Serialized)),
  ];

  await processIncomingCrcCargo(STUB_WORKER_NAME);

  expect(mockPublishedMessages.map(bufferToArray)).toEqual([
    stubParcel1Serialized,
    stubParcel2Serialized,
  ]);

  const cargoSenderAddress = await stubPdaChain.privateGatewayCert.calculateSubjectPrivateAddress();
  expect(mockLogger.info).toBeCalledWith(
    {
      cargoId: (await Cargo.deserialize(stubCargo1Serialized)).id,
      error: expect.any(RAMFSyntaxError),
      senderAddress: cargoSenderAddress,
    },
    `Cargo contains an invalid message`,
  );
});

test('Cargo should be acknowledged after messages have been processed', async () => {
  const stubParcel = new Parcel('recipient-address', stubPdaChain.pdaCert, Buffer.from('hi'));
  const stubParcelSerialized = Buffer.from(
    await stubParcel.serialize(stubPdaChain.pdaGranteePrivateKey),
  );
  const stanMessage = mockStanMessage(await generateCargoSerialized(stubParcelSerialized));
  mockQueueMessages = [stanMessage];

  await processIncomingCrcCargo(STUB_WORKER_NAME);

  expect(stanMessage.ack).toBeCalledTimes(1);
});

test('NATS connection should be closed upon successful completion', async () => {
  await processIncomingCrcCargo(STUB_WORKER_NAME);

  expect(mockNatsClient.disconnect).toBeCalledTimes(1);
  expect(mockNatsClient.disconnect).toBeCalledWith();
});

test('NATS connection should be closed upon error', async () => {
  const error = new Error('Not on my watch');
  // @ts-ignore
  mockNatsClient.makePublisher.mockReturnValue(() => {
    throw error;
  });

  await expect(processIncomingCrcCargo(STUB_WORKER_NAME)).rejects.toEqual(error);

  expect(mockNatsClient.disconnect).toBeCalledTimes(1);
  expect(mockNatsClient.disconnect).toBeCalledWith();
});

async function generateCargo(...items: readonly ArrayBuffer[]): Promise<Cargo> {
  const cargoMessageSet = new CargoMessageSet(new Set(items));
  const payload = await SessionlessEnvelopedData.encrypt(
    cargoMessageSet.serialize(),
    stubPdaChain.publicGatewayCert,
  );
  return new Cargo(
    await stubPdaChain.publicGatewayCert.getCommonName(),
    stubPdaChain.privateGatewayCert,
    Buffer.from(payload.serialize()),
  );
}

async function generateCargoSerialized(...items: readonly ArrayBuffer[]): Promise<ArrayBuffer> {
  const cargo = await generateCargo(...items);
  return cargo.serialize(stubPdaChain.privateGatewayPrivateKey);
}
