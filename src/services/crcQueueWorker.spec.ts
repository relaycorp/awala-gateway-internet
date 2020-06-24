/* tslint:disable:no-let */

import {
  Cargo,
  CargoMessageSet,
  Certificate,
  derSerializePublicKey,
  generateECDHKeyPair,
  InvalidMessageError,
  issueInitialDHKeyCertificate,
  MockPrivateKeyStore,
  MockPublicKeyStore,
  Parcel,
  ParcelCollectionAck,
  PrivateKeyStoreError,
  SessionEnvelopedData,
  SessionlessEnvelopedData,
  SessionPublicKeyData,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import * as stan from 'node-nats-streaming';

import { mockPino, mockSpy, PdaChain } from '../_test_utils';
import * as mongo from '../backingServices/mongo';
import { NatsStreamingClient } from '../backingServices/natsStreaming';
import { ObjectStoreClient } from '../backingServices/objectStorage';
import * as privateKeyStore from '../backingServices/privateKeyStore';
import {
  castMock,
  configureMockEnvVars,
  generatePdaChain,
  getMockContext,
  getMockInstance,
  mockStanMessage,
} from './_test_utils';
import * as mongoPublicKeyStore from './MongoPublicKeyStore';
import * as parcelCollection from './parcelCollection';
import { ParcelStore } from './parcelStore';

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

  async function mockPublishMessage(messageData: Buffer, _channel: string): Promise<void> {
    mockPublishedMessages.push(messageData);
  }

  async function* mockMakeQueueConsumer(): AsyncIterable<stan.Message> {
    for (const message of mockQueueMessages) {
      yield message;
    }
  }

  mockNatsClient = castMock<NatsStreamingClient>({
    disconnect: jest.fn(),
    makeQueueConsumer: jest.fn().mockImplementation(mockMakeQueueConsumer),
    publishMessage: jest.fn().mockImplementation(mockPublishMessage),
  });
});
mockSpy(jest.spyOn(NatsStreamingClient, 'initFromEnv'), () => mockNatsClient);

//region Mongoose-related fixtures

const MOCK_MONGOOSE_CONNECTION = { what: 'mongooseConnection' };
mockSpy(jest.spyOn(mongo, 'createMongooseConnectionFromEnv'), () => MOCK_MONGOOSE_CONNECTION);

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
mockSpy(jest.spyOn(mongoPublicKeyStore, 'MongoPublicKeyStore'), () => mockPublicKeyStore);

//region Parcel store-related fixtures
const OBJECT_STORE_BUCKET = 'the-bucket';
const MOCK_OBJECT_STORE_CLIENT = { what: 'object store client' };
mockSpy(jest.spyOn(ObjectStoreClient, 'initFromEnv'), () => MOCK_OBJECT_STORE_CLIENT);
mockSpy(jest.spyOn(ParcelStore.prototype, 'deleteGatewayBoundParcel'), () => undefined);
mockSpy(
  jest.spyOn(ParcelStore.prototype, 'storeEndpointBoundParcel'),
  async (parcelSerialized: Buffer) => {
    const parcel = await Parcel.deserialize(bufferToArray(parcelSerialized));
    return parcel.id;
  },
);

//region Parcel collection fixtures

mockSpy(jest.spyOn(parcelCollection, 'wasParcelCollected'), () => false);
mockSpy(jest.spyOn(parcelCollection, 'recordParcelCollection'), () => undefined);

//endregion

const BASE_ENV_VARS = {
  NATS_CLUSTER_ID: STUB_NATS_CLUSTER_ID,
  NATS_SERVER_URL: STUB_NATS_SERVER,
  OBJECT_STORE_BUCKET,
  VAULT_KV_PREFIX: STUB_VAULT_KV_PREFIX,
  VAULT_TOKEN: STUB_VAULT_TOKEN,
  VAULT_URL: STUB_VAULT_URL,
};
configureMockEnvVars(BASE_ENV_VARS);

let CERT_CHAIN: PdaChain;
let PUBLIC_GW_SESSION_KEY_PAIR: CryptoKeyPair;
let PUBLIC_GW_SESSION_CERT: Certificate;
beforeAll(async () => {
  CERT_CHAIN = await generatePdaChain();

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  PUBLIC_GW_SESSION_KEY_PAIR = await generateECDHKeyPair();
  PUBLIC_GW_SESSION_CERT = await issueInitialDHKeyCertificate({
    issuerCertificate: CERT_CHAIN.publicGatewayCert,
    issuerPrivateKey: CERT_CHAIN.publicGatewayPrivateKey,
    subjectPublicKey: PUBLIC_GW_SESSION_KEY_PAIR.publicKey,
    validityEndDate: tomorrow,
  });
});

beforeEach(async () => {
  await mockPrivateKeyStore.registerNodeKey(
    CERT_CHAIN.publicGatewayPrivateKey,
    CERT_CHAIN.publicGatewayCert,
  );
  await mockPrivateKeyStore.registerInitialSessionKey(
    PUBLIC_GW_SESSION_KEY_PAIR.privateKey,
    PUBLIC_GW_SESSION_CERT,
  );
});

let PARCEL: Parcel;
let PARCEL_SERIALIZED: ArrayBuffer;
beforeAll(async () => {
  PARCEL = new Parcel('https://example.com', CERT_CHAIN.pdaCert, Buffer.from('hi'), {
    senderCaCertificateChain: [CERT_CHAIN.peerEndpointCert, CERT_CHAIN.privateGatewayCert],
  });
  PARCEL.creationDate.setMilliseconds(0);
  PARCEL_SERIALIZED = await PARCEL.serialize(CERT_CHAIN.pdaGranteePrivateKey);
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
    await CERT_CHAIN.publicGatewayCert.getCommonName(),
    CERT_CHAIN.privateGatewayCert,
    Buffer.from('Not a CMS EnvelopedData value'),
  );
  const cargoSerialized = await cargo.serialize(CERT_CHAIN.privateGatewayPrivateKey);

  const stanMessage = mockStanMessage(cargoSerialized);
  mockQueueMessages = [stanMessage];

  await processIncomingCrcCargo(STUB_WORKER_NAME);

  expect(mockLogger.info).toBeCalledWith(
    {
      cargoId: cargo.id,
      err: expect.objectContaining({ message: expect.stringMatching(/Could not deserialize/) }),
      peerGatewayAddress: await cargo.senderCertificate.calculateSubjectPrivateAddress(),
      worker: STUB_WORKER_NAME,
    },
    `Cargo payload is invalid`,
  );

  expect(stanMessage.ack).toBeCalledTimes(1);
});

test('Keystore errors should be propagated and cargo should remain in the queue', async () => {
  const cargo = await generateCargo();
  const stanMessage = mockStanMessage(await cargo.serialize(CERT_CHAIN.privateGatewayPrivateKey));
  mockQueueMessages = [stanMessage];

  // Mimic a downtime in Vault
  mockPrivateKeyStore = new MockPrivateKeyStore(false, true);

  await expect(processIncomingCrcCargo(STUB_WORKER_NAME)).rejects.toBeInstanceOf(
    PrivateKeyStoreError,
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
    await CERT_CHAIN.publicGatewayCert.getCommonName(),
    CERT_CHAIN.privateGatewayCert,
    Buffer.from(envelopedData.serialize()),
  );
  const stanMessage = mockStanMessage(await cargo.serialize(CERT_CHAIN.privateGatewayPrivateKey));
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

describe('Parcel processing', () => {
  test('Parcels should be stored in the object store', async () => {
    mockQueueMessages = [mockStanMessage(await generateCargoSerialized(PARCEL_SERIALIZED))];

    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(ParcelStore.prototype.storeEndpointBoundParcel).toBeCalledTimes(1);
    expect(ParcelStore.prototype.storeEndpointBoundParcel).toBeCalledWith(
      Buffer.from(PARCEL_SERIALIZED),
    );
  });

  test('Parcels should be published on channel "crc-parcels"', async () => {
    mockQueueMessages = [mockStanMessage(await generateCargoSerialized(PARCEL_SERIALIZED))];

    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(mockNatsClient.publishMessage).toBeCalledTimes(1);
    expect(mockNatsClient.publishMessage).toBeCalledWith(expect.anything(), 'crc-parcels');

    const publishMessageArgs = getMockContext(mockNatsClient.publishMessage).calls[0];
    const messageData = JSON.parse(publishMessageArgs[0].toString());
    expect(messageData).toHaveProperty('parcelExpiryDate', PARCEL.expiryDate.toISOString());
    expect(messageData).toHaveProperty('parcelRecipientAddress', PARCEL.recipientAddress);
    expect(messageData).toHaveProperty('parcelObjectKey', PARCEL.id);
  });

  test('Parcels should have their collection recorded', async () => {
    mockQueueMessages = [mockStanMessage(await generateCargoSerialized(PARCEL_SERIALIZED))];

    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(parcelCollection.recordParcelCollection).toBeCalledTimes(1);
    expect(parcelCollection.recordParcelCollection).toBeCalledWith(
      expect.objectContaining({ id: PARCEL.id }),
      await CERT_CHAIN.privateGatewayCert.calculateSubjectPrivateAddress(),
      MOCK_MONGOOSE_CONNECTION,
    );
  });

  test('Parcels previously received should be ignored', async () => {
    getMockInstance(parcelCollection.wasParcelCollected).mockResolvedValue(true);

    const cargo = await generateCargo(PARCEL_SERIALIZED);
    mockQueueMessages = [
      mockStanMessage(await cargo.serialize(CERT_CHAIN.privateGatewayPrivateKey)),
    ];

    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(mockPublishedMessages).toHaveLength(0);
    expect(parcelCollection.recordParcelCollection).not.toBeCalled();

    expect(mockLogger.debug).toBeCalledWith(
      {
        cargoId: cargo.id,
        parcelId: PARCEL.id,
        parcelSenderAddress: await PARCEL.senderCertificate.calculateSubjectPrivateAddress(),
        peerGatewayAddress: await CERT_CHAIN.privateGatewayCert.calculateSubjectPrivateAddress(),
        worker: STUB_WORKER_NAME,
      },
      'Parcel was previously processed',
    );
  });

  test('Parcels from different gateway should be logged and ignored', async () => {
    const differentPdaChain = await generatePdaChain();
    const parcel = new Parcel('https://example.com', differentPdaChain.pdaCert, Buffer.from('hi'), {
      senderCaCertificateChain: [differentPdaChain.privateGatewayCert],
    });
    const stubParcelSerialized = await parcel.serialize(differentPdaChain.pdaGranteePrivateKey);

    const cargo = await generateCargo(stubParcelSerialized);
    mockQueueMessages = [
      mockStanMessage(await cargo.serialize(CERT_CHAIN.privateGatewayPrivateKey)),
    ];

    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(mockPublishedMessages).toHaveLength(0);

    expect(mockLogger.info).toBeCalledWith(
      {
        cargoId: cargo.id,
        err: expect.any(InvalidMessageError),
        peerGatewayAddress: await CERT_CHAIN.privateGatewayCert.calculateSubjectPrivateAddress(),
        worker: STUB_WORKER_NAME,
      },
      'Parcel is invalid and/or did not originate in the gateway that created the cargo',
    );
  });
});

describe('PCA processing', () => {
  const PCA = new ParcelCollectionAck('0deadbeef', '0deadc0de', 'the-id');

  test('Corresponding parcel should be deleted if it exists', async () => {
    mockQueueMessages = [mockStanMessage(await generateCargoSerialized(PCA.serialize()))];

    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(ParcelStore.prototype.deleteGatewayBoundParcel).toBeCalledWith(
      PCA.parcelId,
      PCA.senderEndpointPrivateAddress,
      PCA.recipientEndpointAddress,
      await CERT_CHAIN.privateGatewayCert.calculateSubjectPrivateAddress(),
    );
    expect(mockPublishedMessages).toHaveLength(0);
  });

  test('Errors while deleting corresponding parcel should be propagated', async () => {
    const err = new Error('Storage server is down');
    getMockInstance(ParcelStore.prototype.deleteGatewayBoundParcel).mockRejectedValue(err);

    const cargo = await generateCargo(PCA.serialize());
    mockQueueMessages = [
      mockStanMessage(await cargo.serialize(CERT_CHAIN.privateGatewayPrivateKey)),
    ];

    await expect(processIncomingCrcCargo(STUB_WORKER_NAME)).rejects.toEqual(err);

    expect(mockPublishedMessages).toHaveLength(0);
  });
});

test('Cargo containing invalid messages should be logged and ignored', async () => {
  // First cargo contains an invalid messages followed by a valid. The second cargo contains
  // one message and it's valid.

  const additionalParcel = new Parcel(
    'https://example.com',
    CERT_CHAIN.pdaCert,
    Buffer.from('hi'),
    {
      senderCaCertificateChain: [CERT_CHAIN.peerEndpointCert, CERT_CHAIN.privateGatewayCert],
    },
  );
  const stubCargo1Serialized = await generateCargoSerialized(
    Buffer.from('Not valid'),
    PARCEL_SERIALIZED,
  );

  mockQueueMessages = [
    mockStanMessage(await stubCargo1Serialized),
    mockStanMessage(
      await generateCargoSerialized(
        await additionalParcel.serialize(CERT_CHAIN.pdaGranteePrivateKey),
      ),
    ),
  ];

  await processIncomingCrcCargo(STUB_WORKER_NAME);

  expect(mockPublishedMessages).toEqual([
    expect.stringMatching(PARCEL.id),
    expect.stringMatching(additionalParcel.id),
  ]);

  const cargoSenderAddress = await CERT_CHAIN.privateGatewayCert.calculateSubjectPrivateAddress();
  expect(mockLogger.info).toBeCalledWith(
    {
      cargoId: (await Cargo.deserialize(stubCargo1Serialized)).id,
      error: expect.any(InvalidMessageError),
      peerGatewayAddress: cargoSenderAddress,
      worker: STUB_WORKER_NAME,
    },
    `Cargo contains an invalid message`,
  );
});

test('Cargo should be acknowledged after messages have been processed', async () => {
  const stubParcel = new Parcel('recipient-address', CERT_CHAIN.pdaCert, Buffer.from('hi'));
  const stubParcelSerialized = Buffer.from(
    await stubParcel.serialize(CERT_CHAIN.pdaGranteePrivateKey),
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
  getMockInstance(mockNatsClient.makeQueueConsumer).mockImplementation(function* (): Iterable<any> {
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
    CERT_CHAIN.publicGatewayCert,
  );
  return new Cargo(
    await CERT_CHAIN.publicGatewayCert.getCommonName(),
    CERT_CHAIN.privateGatewayCert,
    Buffer.from(payload.serialize()),
  );
}

async function generateCargoSerialized(...items: readonly ArrayBuffer[]): Promise<ArrayBuffer> {
  const cargo = await generateCargo(...items);
  return cargo.serialize(CERT_CHAIN.privateGatewayPrivateKey);
}
