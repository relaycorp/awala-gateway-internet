import {
  Cargo,
  CargoMessageSet,
  CertificateRotation,
  CertificationPath,
  CMSError,
  derSerializePublicKey,
  InvalidMessageError,
  KeyStoreError,
  MockKeyStoreSet,
  Parcel,
  ParcelCollectionAck,
  RAMFSyntaxError,
  SessionEnvelopedData,
  SessionKey,
  SessionKeyPair,
  SessionPublicKeyData,
} from '@relaycorp/relaynet-core';
import { CloudEvent } from 'cloudevents';
import { Connection } from 'mongoose';

import * as objectStorage from '../../../backingServices/objectStorage';
import { InternetGatewayManager } from '../../../node/InternetGatewayManager';
import { ParcelStore } from '../../../parcelStore';
import { getMockInstance, mockSpy } from '../../../testUtils/jest';
import { partialPinoLog } from '../../../testUtils/logging';
import { generatePdaChain, PdaChain } from '../../../testUtils/pki';
import { Config, ConfigKey } from '../../../utilities/config';
import { mockRedisPubSubClient } from '../../../testUtils/redis';
import { makeMockQueueServer, makeQueueEventPoster } from '../_test_utils';
import { mockEmitter } from '../../../testUtils/eventing/mockEmitter';
import { HTTP_STATUS_CODES } from '../../../utilities/http';
import { EVENT_TYPES } from './types';
import { InternetGateway } from '../../../node/InternetGateway';

jest.mock('../../../utilities/exitHandling');

const mockKeyStores = new MockKeyStoreSet();
beforeEach(() => {
  mockKeyStores.clear();
});
jest
  .spyOn(InternetGatewayManager, 'init')
  .mockImplementation(async (connection) => new InternetGatewayManager(connection, mockKeyStores));

const MOCK_OBJECT_STORE_CLIENT = { what: 'object store client' };
mockSpy(jest.spyOn(objectStorage, 'initObjectStoreFromEnv'), () => MOCK_OBJECT_STORE_CLIENT);
mockSpy(jest.spyOn(ParcelStore.prototype, 'deleteParcelForPrivatePeer'), () => undefined);
const mockStoreParcelFromPrivatePeer = mockSpy(
  jest.spyOn(ParcelStore.prototype, 'storeParcelFromPrivatePeer'),
  async (parcel: Parcel) => {
    return `parcels/${parcel.id}`;
  },
);

const emitter = mockEmitter();
const mockRedisClient = mockRedisPubSubClient();

const getContext = makeMockQueueServer();
const postQueueEvent = makeQueueEventPoster(getContext);

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

  const config = new Config(getContext().dbConnection);
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

test('Malformed cargo should be logged and ignored', async () => {
  const privatePeerId = '0deadbeef';
  const cargoId = 'cargo-id';
  const event = new CloudEvent({
    type: EVENT_TYPES.CRC_INCOMING_CARGO,
    source: privatePeerId,
    subject: cargoId,
    data: Buffer.from('malformed'),
  });

  await expect(postQueueEvent(event)).resolves.toBe(HTTP_STATUS_CODES.NO_CONTENT);

  expect(getContext().logs).toContainEqual(
    partialPinoLog('info', 'Refusing malformed cargo', {
      err: expect.objectContaining({ type: RAMFSyntaxError.name }),
      cargoId,
      privatePeerId,
    }),
  );
});

test('Cargo with invalid payload should be logged and ignored', async () => {
  const cargo = new Cargo(
    { id: internetGatewayId },
    certificateChain.privateGatewayCert,
    Buffer.from('Not a CMS EnvelopedData value'),
  );
  const event = await encapsulateCargoInEvent(cargo);

  await expect(postQueueEvent(event)).resolves.toBe(HTTP_STATUS_CODES.NO_CONTENT);

  expect(getContext().logs).toContainEqual(
    partialPinoLog('info', 'Cargo payload is invalid', {
      cargoId: cargo.id,
      err: expect.objectContaining({ type: CMSError.name }),
      privatePeerId: await cargo.senderCertificate.calculateSubjectId(),
    }),
  );
});

test('Cargo containing invalid messages should be logged and ignored', async () => {
  const cargo = await generateCargo(Buffer.from('Not valid'), PARCEL_SERIALIZED);
  const event = await encapsulateCargoInEvent(cargo);

  await expect(postQueueEvent(event)).resolves.toBe(HTTP_STATUS_CODES.NO_CONTENT);

  const cargoSenderAddress = await certificateChain.privateGatewayCert.calculateSubjectId();
  expect(getContext().logs).toContainEqual(
    partialPinoLog('info', 'Cargo contains an invalid message', {
      cargoId: cargo.id,
      err: expect.objectContaining({ type: InvalidMessageError.name }),
      privatePeerId: cargoSenderAddress,
    }),
  );
});

test('Keystore errors should be logged and cargo should remain in the queue', async () => {
  const cargo = await generateCargo();
  const event = await encapsulateCargoInEvent(cargo);
  const keyStoreError = new KeyStoreError('The planets are not aligned');
  jest
    .spyOn(InternetGateway.prototype, 'unwrapMessagePayload')
    .mockRejectedValueOnce(keyStoreError);

  await expect(postQueueEvent(event)).resolves.toBe(HTTP_STATUS_CODES.SERVICE_UNAVAILABLE);

  expect(getContext().logs).toContainEqual(
    partialPinoLog('error', 'Failed to use key store to unwrap message', {
      cargoId: cargo.id,
      err: expect.objectContaining({ message: expect.stringMatching(keyStoreError.message) }),
      privatePeerId: await cargo.senderCertificate.calculateSubjectId(),
    }),
  );
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
  const event = await encapsulateCargoInEvent(cargo);

  await expect(postQueueEvent(event)).resolves.toBe(HTTP_STATUS_CODES.NO_CONTENT);

  const originatorSessionKey = await envelopedData.getOriginatorKey();
  const expectedPublicKeyTime = new Date(cargo.creationDate);
  expectedPublicKeyTime.setMilliseconds(0);
  const expectedStoredKeyData: SessionPublicKeyData = {
    publicKeyCreationTime: expectedPublicKeyTime,
    publicKeyDer: await derSerializePublicKey(originatorSessionKey.publicKey),
    publicKeyId: originatorSessionKey.keyId,
  };
  expect(mockKeyStores.publicKeyStore.sessionKeys).toHaveProperty(
    await cargo.senderCertificate.calculateSubjectId(),
    expectedStoredKeyData,
  );
});

describe('Parcel processing', () => {
  test('Parcels should be stored in the object store', async () => {
    const cargo = await generateCargo(PARCEL_SERIALIZED);
    const event = await encapsulateCargoInEvent(cargo);

    await expect(postQueueEvent(event)).resolves.toBe(HTTP_STATUS_CODES.NO_CONTENT);

    expect(mockStoreParcelFromPrivatePeer).toBeCalledWith(
      expect.objectContaining({ id: PARCEL.id }),
      Buffer.from(PARCEL_SERIALIZED),
      await certificateChain.privateGatewayCert.calculateSubjectId(),
      expect.any(Connection),
      emitter,
      mockRedisClient.publishers[0].publish,
      expect.anything(),
    );
    expect(getContext().logs).toContainEqual(
      partialPinoLog('debug', 'Parcel was stored', {
        cargoId: cargo.id,
        parcelId: PARCEL.id,
        parcelSenderAddress: await PARCEL.senderCertificate.calculateSubjectId(),
        privatePeerId: await certificateChain.privateGatewayCert.calculateSubjectId(),
      }),
    );
  });

  test('Parcels previously received should be ignored', async () => {
    mockStoreParcelFromPrivatePeer.mockResolvedValue(false);
    const cargo = await generateCargo(PARCEL_SERIALIZED);
    const event = await encapsulateCargoInEvent(cargo);

    await expect(postQueueEvent(event)).resolves.toBe(HTTP_STATUS_CODES.NO_CONTENT);

    expect(getContext().logs).toContainEqual(
      partialPinoLog('debug', 'Ignoring previously processed parcel', {
        cargoId: cargo.id,
        parcelId: PARCEL.id,
        parcelSenderAddress: await PARCEL.senderCertificate.calculateSubjectId(),
        privatePeerId: await certificateChain.privateGatewayCert.calculateSubjectId(),
      }),
    );
  });

  test('Well-formed yet invalid parcels should be logged and ignored', async () => {
    mockStoreParcelFromPrivatePeer.mockRejectedValue(new InvalidMessageError('Oops'));
    const cargo = await generateCargo(PARCEL_SERIALIZED);
    const event = await encapsulateCargoInEvent(cargo);

    await expect(postQueueEvent(event)).resolves.toBe(HTTP_STATUS_CODES.NO_CONTENT);

    expect(getContext().logs).toContainEqual(
      partialPinoLog('info', 'Parcel is invalid', {
        cargoId: cargo.id,
        err: expect.objectContaining({ type: InvalidMessageError.name }),
        privatePeerId: await certificateChain.privateGatewayCert.calculateSubjectId(),
      }),
    );
  });

  test('Parcel processing should be retried if it fails due to backing service', async () => {
    const error = new Error('Oops');
    mockStoreParcelFromPrivatePeer.mockRejectedValue(error);
    const cargo = await generateCargo(PARCEL_SERIALIZED);
    const event = await encapsulateCargoInEvent(cargo);

    await expect(postQueueEvent(event)).resolves.toBe(HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR);
  });
});

describe('PCA processing', () => {
  const PCA = new ParcelCollectionAck('0deadbeef', '0deadc0de', 'the-id');

  test('Corresponding parcel should be deleted if it exists', async () => {
    const cargo = await generateCargo(PCA.serialize());
    const event = await encapsulateCargoInEvent(cargo);

    await expect(postQueueEvent(event)).resolves.toBe(HTTP_STATUS_CODES.NO_CONTENT);

    expect(ParcelStore.prototype.deleteParcelForPrivatePeer).toBeCalledWith(
      PCA.parcelId,
      PCA.senderEndpointId,
      PCA.recipientEndpointId,
      await certificateChain.privateGatewayCert.calculateSubjectId(),
    );
    expect(getContext().logs).toContainEqual(
      partialPinoLog('info', 'Deleted parcel associated with PCA', {
        cargoId: cargo.id,
        parcelId: PCA.parcelId,
        privatePeerId: await certificateChain.privateGatewayCert.calculateSubjectId(),
      }),
    );
  });

  test('PCA processing should be retried if it fails due to backing service', async () => {
    const err = new Error('Storage server is down');
    getMockInstance(ParcelStore.prototype.deleteParcelForPrivatePeer).mockRejectedValue(err);
    const cargo = await generateCargo(PCA.serialize());
    const event = await encapsulateCargoInEvent(cargo);

    await expect(postQueueEvent(event)).resolves.toBe(HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR);
  });
});

test('CertificateRotation messages should be ignored', async () => {
  const rotation = new CertificateRotation(
    new CertificationPath(certificateChain.internetGatewayCert, [
      certificateChain.internetGatewayCert,
    ]),
  );
  const cargo = await generateCargo(rotation.serialize());
  const event = await encapsulateCargoInEvent(cargo);

  await expect(postQueueEvent(event)).resolves.toBe(HTTP_STATUS_CODES.NO_CONTENT);

  const cargoSenderAddress = await certificateChain.privateGatewayCert.calculateSubjectId();
  expect(getContext().logs).toContainEqual(
    partialPinoLog('info', 'Ignoring certificate rotation message', {
      cargoId: cargo.id,
      privatePeerId: cargoSenderAddress,
    }),
  );
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

async function encapsulateCargoInEvent(cargo: Cargo): Promise<CloudEvent<Buffer>> {
  const cargoSerialized = await cargo.serialize(certificateChain.privateGatewayPrivateKey);
  return new CloudEvent({
    type: EVENT_TYPES.CRC_INCOMING_CARGO,
    subject: cargo.id,
    source: await cargo.senderCertificate.calculateSubjectId(),
    data: Buffer.from(cargoSerialized),
  });
}
