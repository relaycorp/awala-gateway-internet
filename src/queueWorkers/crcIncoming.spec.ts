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
import { Connection } from 'mongoose';
import * as stan from 'node-nats-streaming';

import {
  arrayBufferFrom,
  makeMockLogging,
  MockLogging,
  mockSpy,
  partialPinoLog,
  PdaChain,
} from '../_test_utils';
import * as privateKeyStore from '../backingServices/keyStores';
import * as mongo from '../backingServices/mongo';
import { NatsStreamingClient } from '../backingServices/natsStreaming';
import * as objectStorage from '../backingServices/objectStorage';
import {
  castMock,
  configureMockEnvVars,
  generatePdaChain,
  getMockInstance,
  mockStanMessage,
} from '../services/_test_utils';
import * as mongoPublicKeyStore from '../services/MongoPublicKeyStore';
import { ParcelStore } from '../services/parcelStore';
import * as exitHandling from '../utilities/exitHandling';
import * as logging from '../utilities/logging';
import { processIncomingCrcCargo } from './crcIncoming';

//region Stan-related fixtures

const STUB_WORKER_NAME = 'worker-name';

let mockNatsClient: NatsStreamingClient;
let mockQueueMessages: readonly stan.Message[];
beforeEach(() => {
  mockQueueMessages = [];

  async function* mockMakeQueueConsumer(): AsyncIterable<stan.Message> {
    for (const message of mockQueueMessages) {
      yield message;
    }
  }

  mockNatsClient = castMock<NatsStreamingClient>({
    makeQueueConsumer: jest.fn().mockImplementation(mockMakeQueueConsumer),
  });
});
const mockNatsInitFromEnv = mockSpy(
  jest.spyOn(NatsStreamingClient, 'initFromEnv'),
  () => mockNatsClient,
);

//region Mongoose-related fixtures

const MOCK_MONGOOSE_CONNECTION: Connection = { close: jest.fn() } as any;
mockSpy(jest.spyOn(mongo, 'createMongooseConnectionFromEnv'), () => MOCK_MONGOOSE_CONNECTION);

//region Keystore-related fixtures

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
mockSpy(jest.spyOn(objectStorage, 'initObjectStoreFromEnv'), () => MOCK_OBJECT_STORE_CLIENT);
mockSpy(jest.spyOn(ParcelStore.prototype, 'deleteGatewayBoundParcel'), () => undefined);
const mockStoreParcelFromPeerGateway = mockSpy(
  jest.spyOn(ParcelStore.prototype, 'storeParcelFromPeerGateway'),
  async (parcel: Parcel) => {
    return `parcels/${parcel.id}`;
  },
);

//endregion

const BASE_ENV_VARS = {
  GATEWAY_VERSION: '1',
  OBJECT_STORE_BUCKET,
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

let mockLogging: MockLogging;
beforeAll(() => {
  mockLogging = makeMockLogging();
});
const mockMakeLogger = mockSpy(jest.spyOn(logging, 'makeLogger'), () => mockLogging.logger);

const mockExitHandler = mockSpy(jest.spyOn(exitHandling, 'configureExitHandling'));

describe('Queue subscription', () => {
  test('Logger should be configured', async () => {
    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(mockMakeLogger).toBeCalledWith();
  });

  test('Exit handler should be configured as the very first step', async () => {
    const error = new Error('oh noes');
    mockNatsInitFromEnv.mockImplementation(() => {
      throw error;
    });

    await expect(processIncomingCrcCargo(STUB_WORKER_NAME)).rejects.toEqual(error);
    expect(mockExitHandler).toBeCalledWith(
      expect.toSatisfy((logger) => logger.bindings().worker === STUB_WORKER_NAME),
    );
  });

  test('Start of the queue should be logged', async () => {
    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Starting queue worker', { worker: STUB_WORKER_NAME }),
    );
  });

  test('Worker should subscribe to channel "crc-cargo"', async () => {
    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(mockNatsClient.makeQueueConsumer).toBeCalledWith(
      'crc-cargo',
      expect.anything(),
      expect.anything(),
      undefined,
      expect.anything(),
    );
  });

  test('Subscription should use queue "worker"', async () => {
    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(mockNatsClient.makeQueueConsumer).toBeCalledWith(
      expect.anything(),
      'worker',
      expect.anything(),
      undefined,
      expect.anything(),
    );
  });

  test('Subscription should use durable name "worker"', async () => {
    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(mockNatsClient.makeQueueConsumer).toBeCalledWith(
      expect.anything(),
      expect.anything(),
      'worker',
      undefined,
      expect.anything(),
    );
  });

  test('Subscription should use a client id suffix', async () => {
    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(mockNatsClient.makeQueueConsumer).toBeCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
      '-consumer',
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

  expect(mockLogging.logs).toContainEqual(
    partialPinoLog('info', 'Cargo payload is invalid', {
      cargoId: cargo.id,
      err: expect.objectContaining({ message: expect.stringMatching(/Could not deserialize/) }),
      peerGatewayAddress: await cargo.senderCertificate.calculateSubjectPrivateAddress(),
      worker: STUB_WORKER_NAME,
    }),
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
  const cargoMessageSet = new CargoMessageSet([]);
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
    const cargo = await generateCargo(PARCEL_SERIALIZED);
    mockQueueMessages = [
      mockStanMessage(await cargo.serialize(CERT_CHAIN.privateGatewayPrivateKey)),
    ];

    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(mockStoreParcelFromPeerGateway).toBeCalledWith(
      expect.objectContaining({ id: PARCEL.id }),
      Buffer.from(PARCEL_SERIALIZED),
      await CERT_CHAIN.privateGatewayCert.calculateSubjectPrivateAddress(),
      MOCK_MONGOOSE_CONNECTION,
      mockNatsClient,
      expect.toSatisfy((x) => x.bindings().worker === STUB_WORKER_NAME),
    );
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('debug', 'Parcel was stored', {
        cargoId: cargo.id,
        parcelId: PARCEL.id,
        parcelObjectKey: `parcels/${PARCEL.id}`,
        parcelSenderAddress: await PARCEL.senderCertificate.calculateSubjectPrivateAddress(),
        peerGatewayAddress: await CERT_CHAIN.privateGatewayCert.calculateSubjectPrivateAddress(),
        worker: STUB_WORKER_NAME,
      }),
    );
  });

  test('Parcels previously received should be ignored', async () => {
    mockStoreParcelFromPeerGateway.mockResolvedValue(null);

    const cargo = await generateCargo(PARCEL_SERIALIZED);
    mockQueueMessages = [
      mockStanMessage(await cargo.serialize(CERT_CHAIN.privateGatewayPrivateKey)),
    ];

    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('debug', 'Ignoring previously processed parcel', {
        cargoId: cargo.id,
        parcelId: PARCEL.id,
        parcelObjectKey: null,
        parcelSenderAddress: await PARCEL.senderCertificate.calculateSubjectPrivateAddress(),
        peerGatewayAddress: await CERT_CHAIN.privateGatewayCert.calculateSubjectPrivateAddress(),
        worker: STUB_WORKER_NAME,
      }),
    );
  });

  test('Well-formed yet invalid parcels should be logged and ignored', async () => {
    mockStoreParcelFromPeerGateway.mockRejectedValue(new InvalidMessageError('Oops'));
    const cargo = await generateCargo(PARCEL_SERIALIZED);
    mockQueueMessages = [
      mockStanMessage(await cargo.serialize(CERT_CHAIN.privateGatewayPrivateKey)),
    ];

    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Parcel is invalid', {
        cargoId: cargo.id,
        err: expect.objectContaining({ type: InvalidMessageError.name }),
        peerGatewayAddress: await CERT_CHAIN.privateGatewayCert.calculateSubjectPrivateAddress(),
        worker: STUB_WORKER_NAME,
      }),
    );
  });

  test('Errors in backing services should be propagated', async () => {
    const error = new Error('Oops');
    mockStoreParcelFromPeerGateway.mockRejectedValue(error);
    const cargo = await generateCargo(PARCEL_SERIALIZED);
    mockQueueMessages = [
      mockStanMessage(await cargo.serialize(CERT_CHAIN.privateGatewayPrivateKey)),
    ];

    await expect(processIncomingCrcCargo(STUB_WORKER_NAME)).rejects.toEqual(error);
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
  });

  test('Errors while deleting corresponding parcel should be propagated', async () => {
    const err = new Error('Storage server is down');
    getMockInstance(ParcelStore.prototype.deleteGatewayBoundParcel).mockRejectedValue(err);

    const cargo = await generateCargo(PCA.serialize());
    mockQueueMessages = [
      mockStanMessage(await cargo.serialize(CERT_CHAIN.privateGatewayPrivateKey)),
    ];

    await expect(processIncomingCrcCargo(STUB_WORKER_NAME)).rejects.toEqual(err);
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

  const cargoSenderAddress = await CERT_CHAIN.privateGatewayCert.calculateSubjectPrivateAddress();
  expect(mockLogging.logs).toContainEqual(
    partialPinoLog('info', 'Cargo contains an invalid message', {
      cargoId: (await Cargo.deserialize(stubCargo1Serialized)).id,
      err: expect.objectContaining({ type: InvalidMessageError.name }),
      peerGatewayAddress: cargoSenderAddress,
      worker: STUB_WORKER_NAME,
    }),
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

test('Mongoose connection should be closed when the queue ends', async () => {
  const stanMessage = mockStanMessage(arrayBufferFrom('This is malformed'));
  mockQueueMessages = [stanMessage];

  await expect(processIncomingCrcCargo(STUB_WORKER_NAME)).toReject();

  expect(MOCK_MONGOOSE_CONNECTION.close).toBeCalledTimes(1);
});

async function generateCargo(...items: readonly ArrayBuffer[]): Promise<Cargo> {
  const cargoMessageSet = new CargoMessageSet(items);
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
