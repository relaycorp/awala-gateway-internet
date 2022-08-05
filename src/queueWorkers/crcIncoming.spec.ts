import {
  Cargo,
  CargoMessageSet,
  CertificateRotation,
  CertificationPath,
  derSerializePublicKey,
  InvalidMessageError,
  KeyStoreError,
  MockKeyStoreSet,
  MockPrivateKeyStore,
  Parcel,
  ParcelCollectionAck,
  SessionEnvelopedData,
  SessionKey,
  SessionKeyPair,
  SessionPublicKeyData,
} from '@relaycorp/relaynet-core';
import * as stan from 'node-nats-streaming';

import * as mongo from '../backingServices/mongo';
import { NatsStreamingClient } from '../backingServices/natsStreaming';
import * as objectStorage from '../backingServices/objectStorage';
import { InternetGatewayError } from '../errors';
import { InternetGatewayManager } from '../node/InternetGatewayManager';
import { ParcelStore } from '../parcelStore';
import { GATEWAY_INTERNET_ADDRESS } from '../testUtils/awala';
import { arrayBufferFrom } from '../testUtils/buffers';
import { setUpTestDBConnection } from '../testUtils/db';
import { configureMockEnvVars } from '../testUtils/envVars';
import { castMock, getMockInstance, getPromiseRejection, mockSpy } from '../testUtils/jest';
import { makeMockLogging, MockLogging, partialPinoLog } from '../testUtils/logging';
import { generatePdaChain, PdaChain } from '../testUtils/pki';
import { mockStanMessage } from '../testUtils/stan';
import { Config, ConfigKey } from '../utilities/config';
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

const getMongoConnection = setUpTestDBConnection();
mockSpy(jest.spyOn(mongo, 'createMongooseConnectionFromEnv'), getMongoConnection);

//region Keystore-related fixtures

const mockKeyStores = new MockKeyStoreSet();
beforeEach(() => {
  mockKeyStores.clear();
});
const mockManagerInit = mockSpy(
  jest.spyOn(InternetGatewayManager, 'init'),
  (connection) => new InternetGatewayManager(connection, mockKeyStores),
);

//region Parcel store-related fixtures
const OBJECT_STORE_BUCKET = 'the-bucket';
const MOCK_OBJECT_STORE_CLIENT = { what: 'object store client' };
mockSpy(jest.spyOn(objectStorage, 'initObjectStoreFromEnv'), () => MOCK_OBJECT_STORE_CLIENT);
mockSpy(jest.spyOn(ParcelStore.prototype, 'deleteParcelForPrivatePeer'), () => undefined);
const mockStoreParcelFromPrivatePeer = mockSpy(
  jest.spyOn(ParcelStore.prototype, 'storeParcelFromPrivatePeer'),
  async (parcel: Parcel) => {
    return `parcels/${parcel.id}`;
  },
);

//endregion

const BASE_ENV_VARS = {
  GATEWAY_VERSION: '1',
  OBJECT_STORE_BUCKET,
  PUBLIC_ADDRESS: GATEWAY_INTERNET_ADDRESS,
};
configureMockEnvVars(BASE_ENV_VARS);

let certificateChain: PdaChain;
let internetGatewayId: string;
let internetGatewaySessionPrivateKey: CryptoKey;
let internetGatewaySessionKey: SessionKey;
beforeAll(async () => {
  certificateChain = await generatePdaChain();

  internetGatewayId = await certificateChain.internetGatewayCert.calculateSubjectId();

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const sessionKeyPair = await SessionKeyPair.generate();
  internetGatewaySessionKey = sessionKeyPair.sessionKey;
  internetGatewaySessionPrivateKey = sessionKeyPair.privateKey;
});

beforeEach(async () => {
  await mockKeyStores.privateKeyStore.saveIdentityKey(
    internetGatewayId,
    certificateChain.internetGatewayPrivateKey,
  );
  await mockKeyStores.privateKeyStore.saveSessionKey(
    internetGatewaySessionPrivateKey,
    internetGatewaySessionKey.keyId,
    internetGatewayId,
  );

  const mongoConnection = getMongoConnection();
  const config = new Config(mongoConnection);
  await config.set(ConfigKey.CURRENT_ID, internetGatewayId);
});

let PARCEL: Parcel;
let PARCEL_SERIALIZED: ArrayBuffer;
beforeAll(async () => {
  PARCEL = new Parcel({ id: '0deadbeef' }, certificateChain.pdaCert, Buffer.from('hi'), {
    senderCaCertificateChain: [
      certificateChain.peerEndpointCert,
      certificateChain.privateGatewayCert,
    ],
  });
  PARCEL.creationDate.setMilliseconds(0);
  PARCEL_SERIALIZED = await PARCEL.serialize(certificateChain.pdaGranteePrivateKey);
});

let mockLogging: MockLogging;
beforeEach(() => {
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
    { id: internetGatewayId },
    certificateChain.privateGatewayCert,
    Buffer.from('Not a CMS EnvelopedData value'),
  );
  const cargoSerialized = await cargo.serialize(certificateChain.privateGatewayPrivateKey);

  const stanMessage = mockStanMessage(cargoSerialized);
  mockQueueMessages = [stanMessage];

  await processIncomingCrcCargo(STUB_WORKER_NAME);

  expect(mockLogging.logs).toContainEqual(
    partialPinoLog('info', 'Cargo payload is invalid', {
      cargoId: cargo.id,
      err: expect.objectContaining({ message: expect.stringMatching(/Could not deserialize/) }),
      privatePeerId: await cargo.senderCertificate.calculateSubjectId(),
      worker: STUB_WORKER_NAME,
    }),
  );

  expect(stanMessage.ack).toBeCalledTimes(1);
});

test('Keystore errors should be propagated and cargo should remain in the queue', async () => {
  const cargo = await generateCargo();
  const stanMessage = mockStanMessage(
    await cargo.serialize(certificateChain.privateGatewayPrivateKey),
  );
  mockQueueMessages = [stanMessage];
  const privateKeyStore = new MockPrivateKeyStore();
  await privateKeyStore.saveIdentityKey(
    internetGatewayId,
    certificateChain.internetGatewayPrivateKey,
  );
  const keyStoreError = new KeyStoreError('The planets are not aligned');
  jest.spyOn(privateKeyStore, 'retrieveSessionKey').mockRejectedValue(keyStoreError);
  mockManagerInit.mockImplementation(
    async (connection) =>
      new InternetGatewayManager(connection, { ...mockKeyStores, privateKeyStore }),
  );

  const error = await getPromiseRejection(
    processIncomingCrcCargo(STUB_WORKER_NAME),
    InternetGatewayError,
  );

  expect(error.message).toStartWith('Failed to use key store to unwrap message:');
  expect(error.cause()).toEqual(keyStoreError);
  expect(stanMessage.ack).not.toBeCalled();
});

test('Session keys of sender should be stored if present', async () => {
  const cargoMessageSet = new CargoMessageSet([]);
  const { envelopedData } = await SessionEnvelopedData.encrypt(
    cargoMessageSet.serialize(),
    internetGatewaySessionKey,
  );
  const cargo = new Cargo(
    { id: internetGatewayId },
    certificateChain.privateGatewayCert,
    Buffer.from(envelopedData.serialize()),
  );
  const stanMessage = mockStanMessage(
    await cargo.serialize(certificateChain.privateGatewayPrivateKey),
  );
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
  await expect(mockKeyStores.publicKeyStore.sessionKeys).toHaveProperty(
    await cargo.senderCertificate.calculateSubjectId(),
    expectedStoredKeyData,
  );
});

describe('Parcel processing', () => {
  test('Parcels should be stored in the object store', async () => {
    const cargo = await generateCargo(PARCEL_SERIALIZED);
    mockQueueMessages = [
      mockStanMessage(await cargo.serialize(certificateChain.privateGatewayPrivateKey)),
    ];

    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(mockStoreParcelFromPrivatePeer).toBeCalledWith(
      expect.objectContaining({ id: PARCEL.id }),
      Buffer.from(PARCEL_SERIALIZED),
      await certificateChain.privateGatewayCert.calculateSubjectId(),
      getMongoConnection(),
      mockNatsClient,
      expect.toSatisfy((x) => x.bindings().worker === STUB_WORKER_NAME),
    );
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('debug', 'Parcel was stored', {
        cargoId: cargo.id,
        parcelId: PARCEL.id,
        parcelObjectKey: `parcels/${PARCEL.id}`,
        parcelSenderAddress: await PARCEL.senderCertificate.calculateSubjectId(),
        privatePeerId: await certificateChain.privateGatewayCert.calculateSubjectId(),
        worker: STUB_WORKER_NAME,
      }),
    );
  });

  test('Parcels previously received should be ignored', async () => {
    mockStoreParcelFromPrivatePeer.mockResolvedValue(null);

    const cargo = await generateCargo(PARCEL_SERIALIZED);
    mockQueueMessages = [
      mockStanMessage(await cargo.serialize(certificateChain.privateGatewayPrivateKey)),
    ];

    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('debug', 'Ignoring previously processed parcel', {
        cargoId: cargo.id,
        parcelId: PARCEL.id,
        parcelObjectKey: null,
        parcelSenderAddress: await PARCEL.senderCertificate.calculateSubjectId(),
        privatePeerId: await certificateChain.privateGatewayCert.calculateSubjectId(),
        worker: STUB_WORKER_NAME,
      }),
    );
  });

  test('Well-formed yet invalid parcels should be logged and ignored', async () => {
    mockStoreParcelFromPrivatePeer.mockRejectedValue(new InvalidMessageError('Oops'));
    const cargo = await generateCargo(PARCEL_SERIALIZED);
    mockQueueMessages = [
      mockStanMessage(await cargo.serialize(certificateChain.privateGatewayPrivateKey)),
    ];

    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Parcel is invalid', {
        cargoId: cargo.id,
        err: expect.objectContaining({ type: InvalidMessageError.name }),
        privatePeerId: await certificateChain.privateGatewayCert.calculateSubjectId(),
        worker: STUB_WORKER_NAME,
      }),
    );
  });

  test('Errors in backing services should be propagated', async () => {
    const error = new Error('Oops');
    mockStoreParcelFromPrivatePeer.mockRejectedValue(error);
    const cargo = await generateCargo(PARCEL_SERIALIZED);
    mockQueueMessages = [
      mockStanMessage(await cargo.serialize(certificateChain.privateGatewayPrivateKey)),
    ];

    await expect(processIncomingCrcCargo(STUB_WORKER_NAME)).rejects.toEqual(error);
  });
});

describe('PCA processing', () => {
  const PCA = new ParcelCollectionAck('0deadbeef', '0deadc0de', 'the-id');

  test('Corresponding parcel should be deleted if it exists', async () => {
    mockQueueMessages = [mockStanMessage(await generateCargoSerialized(PCA.serialize()))];

    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(ParcelStore.prototype.deleteParcelForPrivatePeer).toBeCalledWith(
      PCA.parcelId,
      PCA.senderEndpointId,
      PCA.recipientEndpointId,
      await certificateChain.privateGatewayCert.calculateSubjectId(),
    );
  });

  test('Errors while deleting corresponding parcel should be propagated', async () => {
    const err = new Error('Storage server is down');
    getMockInstance(ParcelStore.prototype.deleteParcelForPrivatePeer).mockRejectedValue(err);

    const cargo = await generateCargo(PCA.serialize());
    mockQueueMessages = [
      mockStanMessage(await cargo.serialize(certificateChain.privateGatewayPrivateKey)),
    ];

    await expect(processIncomingCrcCargo(STUB_WORKER_NAME)).rejects.toEqual(err);
  });
});

test('CertificateRotation messages should be ignored', async () => {
  const rotation = new CertificateRotation(
    new CertificationPath(certificateChain.internetGatewayCert, [
      certificateChain.internetGatewayCert,
    ]),
  );
  const cargoSerialized = await generateCargoSerialized(rotation.serialize());
  mockQueueMessages = [mockStanMessage(cargoSerialized)];

  await processIncomingCrcCargo(STUB_WORKER_NAME);

  const cargoSenderAddress = await certificateChain.privateGatewayCert.calculateSubjectId();
  expect(mockLogging.logs).toContainEqual(
    partialPinoLog('info', 'Ignoring certificate rotation message', {
      cargoId: (await Cargo.deserialize(cargoSerialized)).id,
      privatePeerId: cargoSenderAddress,
      worker: STUB_WORKER_NAME,
    }),
  );
});

test('Cargo containing invalid messages should be logged and ignored', async () => {
  // First cargo contains an invalid messages followed by a valid. The second cargo contains
  // one message and it's valid.

  const additionalParcel = new Parcel(
    { id: '0deadbeef' },
    certificateChain.pdaCert,
    Buffer.from('hi'),
    {
      senderCaCertificateChain: [
        certificateChain.peerEndpointCert,
        certificateChain.privateGatewayCert,
      ],
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
        await additionalParcel.serialize(certificateChain.pdaGranteePrivateKey),
      ),
    ),
  ];

  await processIncomingCrcCargo(STUB_WORKER_NAME);

  const cargoSenderAddress = await certificateChain.privateGatewayCert.calculateSubjectId();
  expect(mockLogging.logs).toContainEqual(
    partialPinoLog('info', 'Cargo contains an invalid message', {
      cargoId: (await Cargo.deserialize(stubCargo1Serialized)).id,
      err: expect.objectContaining({ type: InvalidMessageError.name }),
      privatePeerId: cargoSenderAddress,
      worker: STUB_WORKER_NAME,
    }),
  );
});

test('Cargo should be acknowledged after messages have been processed', async () => {
  const stubParcel = new Parcel({ id: '0deadbeef' }, certificateChain.pdaCert, Buffer.from('hi'));
  const stubParcelSerialized = Buffer.from(
    await stubParcel.serialize(certificateChain.pdaGranteePrivateKey),
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

  expect(getMongoConnection().readyState).toEqual(0);
});

async function generateCargo(...items: readonly ArrayBuffer[]): Promise<Cargo> {
  const cargoMessageSet = new CargoMessageSet(items);
  const { envelopedData } = await SessionEnvelopedData.encrypt(
    cargoMessageSet.serialize(),
    internetGatewaySessionKey,
  );
  return new Cargo(
    { id: internetGatewayId },
    certificateChain.privateGatewayCert,
    Buffer.from(envelopedData.serialize()),
  );
}

async function generateCargoSerialized(...items: readonly ArrayBuffer[]): Promise<ArrayBuffer> {
  const cargo = await generateCargo(...items);
  return cargo.serialize(certificateChain.privateGatewayPrivateKey);
}
