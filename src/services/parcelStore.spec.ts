// tslint:disable:no-let

import { InvalidMessageError, Parcel } from '@relaycorp/relaynet-core';
import { EnvVarError } from 'env-var';
import { Connection } from 'mongoose';

import {
  arrayToAsyncIterable,
  asyncIterableToArray,
  makeMockLogging,
  MockLogging,
  mockSpy,
  partialPinoLog,
  PdaChain,
  sha256Hex,
} from '../_test_utils';
import * as natsStreaming from '../backingServices/natsStreaming';
import { ObjectStoreClient, StoreObject } from '../backingServices/objectStorage';
import { configureMockEnvVars, generatePdaChain } from './_test_utils';
import * as certs from './certs';
import * as parcelCollection from './parcelCollection';
import { ParcelStore, QueuedInternetBoundParcelMessage } from './parcelStore';

const BUCKET = 'the-bucket-name';

let PDA_CHAIN: PdaChain;
let PRIVATE_GATEWAY_ADDRESS: string;
beforeAll(async () => {
  PDA_CHAIN = await generatePdaChain();
  PRIVATE_GATEWAY_ADDRESS = await PDA_CHAIN.privateGatewayCert.calculateSubjectPrivateAddress();
});

let PARCEL: Parcel;
let PARCEL_SERIALIZED: Buffer;
beforeAll(async () => {
  PARCEL = new Parcel(
    await PDA_CHAIN.peerEndpointCert.calculateSubjectPrivateAddress(),
    PDA_CHAIN.pdaCert,
    Buffer.from([]),
    { senderCaCertificateChain: [PDA_CHAIN.peerEndpointCert, PDA_CHAIN.privateGatewayCert] },
  );
  PARCEL_SERIALIZED = Buffer.from(await PARCEL.serialize(PDA_CHAIN.pdaGranteePrivateKey));
});

const mockNatsClient: natsStreaming.NatsStreamingClient = {
  publishMessage: mockSpy(jest.fn()),
} as any;
const mockMongooseConnection: Connection = mockSpy(jest.fn()) as any;

describe('retrieveActiveParcelsForGateway', () => {
  const mockGetObject = mockSpy(jest.fn());
  const mockListObjectKeys = mockSpy(jest.fn(), () => arrayToAsyncIterable([]));
  const mockObjectStoreClient: ObjectStoreClient = {
    getObject: mockGetObject,
    listObjectKeys: mockListObjectKeys,
  } as any;
  const store = new ParcelStore(mockObjectStoreClient, BUCKET);

  let mockLogging: MockLogging;
  beforeEach(() => {
    mockLogging = makeMockLogging();
  });

  test('Parcels should be limited to those for the specified gateway', async () => {
    await asyncIterableToArray(
      store.retrieveActiveParcelsForGateway(PRIVATE_GATEWAY_ADDRESS, mockLogging.logger),
    );
    expect(mockListObjectKeys).toBeCalledTimes(1);
    expect(mockListObjectKeys).toBeCalledWith(
      `parcels/gateway-bound/${PRIVATE_GATEWAY_ADDRESS}/`,
      expect.anything(),
    );
  });

  test('Operations should be limited to the specified bucket', async () => {
    const objectsByKey = {
      'prefix/1.parcel': {
        body: PARCEL_SERIALIZED,
        metadata: { 'parcel-expiry': getTimestampRelativeToNow(1) },
      },
    };
    setMockParcelObjectStore(objectsByKey);

    await asyncIterableToArray(
      store.retrieveActiveParcelsForGateway(PRIVATE_GATEWAY_ADDRESS, mockLogging.logger),
    );
    expect(mockListObjectKeys).toBeCalledTimes(1);
    expect(mockListObjectKeys).toBeCalledWith(expect.anything(), BUCKET);
    expect(mockGetObject).toBeCalledTimes(1);
    expect(mockGetObject).toBeCalledWith(expect.anything(), BUCKET);
  });

  test('Active parcels should be output', async () => {
    const parcel1ExpiryDate = getDateRelativeToNow(1);
    const parcel2ExpiryDate = getDateRelativeToNow(2);
    const parcel2Body = Buffer.from('Another parcel');
    const objectsByKey: { readonly [key: string]: StoreObject } = {
      'prefix/1.parcel': {
        body: PARCEL_SERIALIZED,
        metadata: { 'parcel-expiry': getTimestamp(parcel1ExpiryDate).toString() },
      },
      'prefix/2.parcel': {
        body: parcel2Body,
        metadata: { 'parcel-expiry': getTimestamp(parcel2ExpiryDate).toString() },
      },
    };
    setMockParcelObjectStore(objectsByKey);

    const activeParcels = await asyncIterableToArray(
      store.retrieveActiveParcelsForGateway(PRIVATE_GATEWAY_ADDRESS, mockLogging.logger),
    );

    expect(activeParcels).toEqual([
      { expiryDate: parcel1ExpiryDate, message: PARCEL_SERIALIZED },
      { expiryDate: parcel2ExpiryDate, message: parcel2Body },
    ]);
  });

  test('Objects deleted since the listing should be gracefully skipped', async () => {
    const parcelObjectKey = 'prefix/active.parcel';
    const deletedObjectKey = 'prefix/deleted.parcel';
    mockListObjectKeys.mockReturnValue(arrayToAsyncIterable([deletedObjectKey, parcelObjectKey]));
    const error = new Error('That was deleted');
    mockGetObject.mockImplementation((objectKey) => {
      if (objectKey !== parcelObjectKey) {
        throw error;
      }
      return {
        body: PARCEL_SERIALIZED,
        metadata: { 'parcel-expiry': getTimestampRelativeToNow(2) },
      };
    });

    const activeParcels = await asyncIterableToArray(
      store.retrieveActiveParcelsForGateway(PRIVATE_GATEWAY_ADDRESS, mockLogging.logger),
    );
    expect(activeParcels).toEqual([{ expiryDate: expect.anything(), message: PARCEL_SERIALIZED }]);

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog(
        'info',
        'Parcel object could not be found; it could have been deleted since keys were retrieved',
        {
          err: expect.objectContaining({ message: error.message }),
          parcelObjectKey: deletedObjectKey,
        },
      ),
    );
  });

  test('Expired parcels should be filtered out', async () => {
    const objectsByKey = {
      'prefix/active.parcel': {
        body: PARCEL_SERIALIZED,
        metadata: { 'parcel-expiry': getTimestampRelativeToNow(1) },
      },
      'prefix/expired.parcel': {
        body: Buffer.from('Expired parcel'),
        metadata: { 'parcel-expiry': getTimestampRelativeToNow(0) },
      },
    };
    setMockParcelObjectStore(objectsByKey);

    const activeParcels = await asyncIterableToArray(
      store.retrieveActiveParcelsForGateway(PRIVATE_GATEWAY_ADDRESS, mockLogging.logger),
    );
    expect(activeParcels).toEqual([{ expiryDate: expect.anything(), message: PARCEL_SERIALIZED }]);
  });

  test('Objects without expiry metadata should be skipped and reported in the logs', async () => {
    const invalidParcelKey = 'prefix/invalid.parcel';
    const objectsByKey = {
      'prefix/active.parcel': {
        body: PARCEL_SERIALIZED,
        metadata: { 'parcel-expiry': getTimestampRelativeToNow(1) },
      },
      [invalidParcelKey]: {
        body: Buffer.from('Invalid parcel'),
        metadata: {},
      },
    };
    setMockParcelObjectStore(objectsByKey);

    const activeParcels = await asyncIterableToArray(
      store.retrieveActiveParcelsForGateway(PRIVATE_GATEWAY_ADDRESS, mockLogging.logger),
    );
    expect(activeParcels).toEqual([{ expiryDate: expect.anything(), message: PARCEL_SERIALIZED }]);

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('warn', 'Parcel object does not have a valid expiry timestamp metadata', {
        parcelObjectKey: invalidParcelKey,
      }),
    );
  });

  test('Objects whose expiry is not an integer should be skipped and reported in the logs', async () => {
    const invalidParcelKey = 'prefix/invalid.parcel';
    const objectsByKey = {
      'prefix/active.parcel': {
        body: PARCEL_SERIALIZED,
        metadata: { 'parcel-expiry': getTimestampRelativeToNow(1) },
      },
      [invalidParcelKey]: {
        body: Buffer.from('Invalid parcel'),
        metadata: { 'parcel-expiry': 'I have seen many numbers in my life. This is not one.' },
      },
    };
    setMockParcelObjectStore(objectsByKey);

    const activeParcels = await asyncIterableToArray(
      store.retrieveActiveParcelsForGateway(PRIVATE_GATEWAY_ADDRESS, mockLogging.logger),
    );
    expect(activeParcels).toEqual([{ expiryDate: expect.anything(), message: PARCEL_SERIALIZED }]);

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('warn', 'Parcel object does not have a valid expiry timestamp metadata', {
        parcelObjectKey: invalidParcelKey,
      }),
    );
  });

  function setMockParcelObjectStore(objectsByKey: { readonly [key: string]: StoreObject }): void {
    mockListObjectKeys.mockReturnValue(arrayToAsyncIterable(Object.keys(objectsByKey)));
    mockGetObject.mockImplementation((objectKey) => objectsByKey[objectKey]);
  }

  function getDateRelativeToNow(deltaSeconds: number): Date {
    const date = new Date();
    date.setSeconds(date.getSeconds() + deltaSeconds, 0);
    return date;
  }

  function getTimestampRelativeToNow(deltaSeconds: number): string {
    const date = getDateRelativeToNow(deltaSeconds);
    return getTimestamp(date).toString();
  }
});

describe('storeParcelFromPeerGateway', () => {
  const mockObjectStoreClient: ObjectStoreClient = {} as any;
  const dummyObjectKey = 'the object key';

  test('Parcel should be bound for private gateway if recipient is private', async () => {
    const store = new ParcelStore(mockObjectStoreClient, BUCKET);
    const spiedStoreGatewayBoundParcel = jest
      .spyOn(store, 'storeGatewayBoundParcel')
      .mockImplementationOnce(async () => dummyObjectKey);

    // Make sure the shared fixture remains valid for this test:
    expect(PARCEL.isRecipientAddressPrivate).toBeTrue();

    await expect(
      store.storeParcelFromPeerGateway(
        PARCEL,
        PARCEL_SERIALIZED,
        await PDA_CHAIN.privateGatewayCert.calculateSubjectPrivateAddress(),
        mockMongooseConnection,
        mockNatsClient,
      ),
    ).resolves.toEqual(dummyObjectKey);

    expect(spiedStoreGatewayBoundParcel).toBeCalledWith(
      PARCEL,
      PARCEL_SERIALIZED,
      mockMongooseConnection,
      mockNatsClient,
    );
  });

  test('Parcel should be bound for public endpoint if recipient is public', async () => {
    const store = new ParcelStore(mockObjectStoreClient, BUCKET);
    const spiedStoreEndpointBoundParcel = jest
      .spyOn(store, 'storeEndpointBoundParcel')
      .mockImplementationOnce(async () => dummyObjectKey);

    const parcel = new Parcel(
      'https://endpoint.relaycorp.tech',
      PDA_CHAIN.pdaCert,
      Buffer.from([]),
      { senderCaCertificateChain: [PDA_CHAIN.peerEndpointCert, PDA_CHAIN.privateGatewayCert] },
    );
    const parcelSerialized = Buffer.from(await parcel.serialize(PDA_CHAIN.pdaGranteePrivateKey));

    await expect(
      store.storeParcelFromPeerGateway(
        parcel,
        parcelSerialized,
        await PDA_CHAIN.privateGatewayCert.calculateSubjectPrivateAddress(),
        mockMongooseConnection,
        mockNatsClient,
      ),
    ).resolves.toEqual(dummyObjectKey);

    expect(spiedStoreEndpointBoundParcel).toBeCalledWith(
      parcel,
      parcelSerialized,
      await PDA_CHAIN.privateGatewayCert.calculateSubjectPrivateAddress(),
      mockMongooseConnection,
      mockNatsClient,
    );
  });
});

describe('storeGatewayBoundParcel', () => {
  const mockPutObject = mockSpy(jest.fn());
  const mockObjectStoreClient: ObjectStoreClient = { putObject: mockPutObject } as any;
  const store = new ParcelStore(mockObjectStoreClient, BUCKET);

  const mockRetrieveOwnCertificates = mockSpy(
    jest.spyOn(certs, 'retrieveOwnCertificates'),
    async () => [PDA_CHAIN.publicGatewayCert],
  );

  test('Parcel should be refused if sender is not trusted', async () => {
    const differentPDAChain = await generatePdaChain();
    mockRetrieveOwnCertificates.mockResolvedValue([differentPDAChain.publicGatewayCert]);

    await expect(
      store.storeGatewayBoundParcel(
        PARCEL,
        PARCEL_SERIALIZED,
        mockMongooseConnection,
        mockNatsClient,
      ),
    ).rejects.toBeInstanceOf(InvalidMessageError);
    expect(mockPutObject).not.toBeCalled();
  });

  test('Parcel object key should be output', async () => {
    const key = await store.storeGatewayBoundParcel(
      PARCEL,
      PARCEL_SERIALIZED,
      mockMongooseConnection,
      mockNatsClient,
    );

    const expectedObjectKey = [
      'parcels',
      'gateway-bound',
      PRIVATE_GATEWAY_ADDRESS,
      PARCEL.recipientAddress,
      await PARCEL.senderCertificate.calculateSubjectPrivateAddress(),
      sha256Hex(PARCEL.id),
    ].join('/');
    expect(key).toEqual(expectedObjectKey);
  });

  test('Parcel should be put in the right bucket', async () => {
    await store.storeGatewayBoundParcel(
      PARCEL,
      PARCEL_SERIALIZED,
      mockMongooseConnection,
      mockNatsClient,
    );

    expect(mockPutObject).toBeCalledWith(expect.anything(), expect.anything(), BUCKET);
  });

  test('Parcel expiry date should be stored as object metadata', async () => {
    await store.storeGatewayBoundParcel(
      PARCEL,
      PARCEL_SERIALIZED,
      mockMongooseConnection,
      mockNatsClient,
    );

    expect(mockPutObject).toBeCalledWith(
      expect.objectContaining({
        metadata: { ['parcel-expiry']: getTimestamp(PARCEL.expiryDate).toString() },
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  test('Parcel serialization should be stored', async () => {
    await store.storeGatewayBoundParcel(
      PARCEL,
      PARCEL_SERIALIZED,
      mockMongooseConnection,
      mockNatsClient,
    );

    expect(mockPutObject).toBeCalledWith(
      expect.objectContaining({ body: PARCEL_SERIALIZED }),
      expect.anything(),
      expect.anything(),
    );
  });

  test('Parcel object key should be unique for the parcel, sender and recipient', async () => {
    const key = await store.storeGatewayBoundParcel(
      PARCEL,
      PARCEL_SERIALIZED,
      mockMongooseConnection,
      mockNatsClient,
    );

    expect(mockPutObject).toBeCalledWith(expect.anything(), key, expect.anything());
  });

  test('Parcel object key should be published to right NATS Streaming channel', async () => {
    const key = await store.storeGatewayBoundParcel(
      PARCEL,
      PARCEL_SERIALIZED,
      mockMongooseConnection,
      mockNatsClient,
    );

    expect(mockNatsClient.publishMessage).toBeCalledTimes(1);
    expect(mockNatsClient.publishMessage).toBeCalledWith(
      key,
      `pdc-parcel.${await PDA_CHAIN.privateGatewayCert.calculateSubjectPrivateAddress()}`,
    );
  });
});

describe('deleteGatewayBoundParcel', () => {
  const mockDeleteObject = mockSpy(jest.fn(), async () => ({ body: PARCEL_SERIALIZED }));
  const mockObjectStoreClient: ObjectStoreClient = { deleteObject: mockDeleteObject } as any;
  const store = new ParcelStore(mockObjectStoreClient, BUCKET);

  test('Object should be deleted from the right bucket', async () => {
    await store.deleteGatewayBoundParcel('', '', '', '');

    expect(mockDeleteObject).toBeCalledWith(expect.anything(), BUCKET);
  });

  test('Full object key should be prefixed', async () => {
    const parcelId = 'thingy.parcel';
    const senderPrivateAddress = '0deadbeef';
    const recipientAddress = '0deadc0de';
    const recipientGatewayAddress = '0beef';
    await store.deleteGatewayBoundParcel(
      parcelId,
      senderPrivateAddress,
      recipientAddress,
      recipientGatewayAddress,
    );

    expect(mockDeleteObject).toBeCalledWith(
      [
        'parcels/gateway-bound',
        recipientGatewayAddress,
        recipientAddress,
        senderPrivateAddress,
        sha256Hex(parcelId),
      ].join('/'),
      expect.anything(),
    );
  });
});

describe('retrieveEndpointBoundParcel', () => {
  const mockGetObject = mockSpy(jest.fn(), async () => ({ body: PARCEL_SERIALIZED }));
  const mockObjectStoreClient: ObjectStoreClient = { getObject: mockGetObject } as any;
  const store = new ParcelStore(mockObjectStoreClient, BUCKET);

  test('Object should be retrieved from the right bucket', async () => {
    await store.retrieveEndpointBoundParcel('');

    expect(mockGetObject).toBeCalledWith(expect.anything(), BUCKET);
  });

  test('Lookup object key should be prefixed', async () => {
    const key = 'thingy.parcel';
    await store.retrieveEndpointBoundParcel(key);

    expect(mockGetObject).toBeCalledWith(`parcels/endpoint-bound/${key}`, expect.anything());
  });

  test('Parcel should be returned', async () => {
    const parcelSerialized = await store.retrieveEndpointBoundParcel('key');

    expect(parcelSerialized).toEqual(PARCEL_SERIALIZED);
  });
});

describe('storeEndpointBoundParcel', () => {
  const mockPutObject = mockSpy(jest.fn());
  const mockObjectStoreClient: ObjectStoreClient = { putObject: mockPutObject } as any;
  const store = new ParcelStore(mockObjectStoreClient, BUCKET);

  const mockWasParcelCollected = mockSpy(
    jest.spyOn(parcelCollection, 'wasParcelCollected'),
    () => false,
  );
  const mockRecordParcelCollection = mockSpy(
    jest.spyOn(parcelCollection, 'recordParcelCollection'),
    () => undefined,
  );

  test('Parcel should be refused if it is invalid', async () => {
    const invalidParcelCreationDate = new Date(PDA_CHAIN.pdaCert.startDate.getTime());
    invalidParcelCreationDate.setSeconds(invalidParcelCreationDate.getSeconds() - 1);
    const invalidParcel = new Parcel(
      await PDA_CHAIN.peerEndpointCert.calculateSubjectPrivateAddress(),
      PDA_CHAIN.pdaCert,
      Buffer.from([]),
      { creationDate: invalidParcelCreationDate },
    );
    const invalidParcelSerialized = await invalidParcel.serialize(PDA_CHAIN.pdaGranteePrivateKey);

    await expect(
      store.storeEndpointBoundParcel(
        invalidParcel,
        Buffer.from(invalidParcelSerialized),
        PRIVATE_GATEWAY_ADDRESS,
        mockMongooseConnection,
        mockNatsClient,
      ),
    ).rejects.toBeInstanceOf(InvalidMessageError);
    expect(mockPutObject).not.toBeCalled();
  });

  test('Parcel should be ignored if it was already processed', async () => {
    mockWasParcelCollected.mockResolvedValue(true);

    await expect(
      store.storeEndpointBoundParcel(
        PARCEL,
        PARCEL_SERIALIZED,
        PRIVATE_GATEWAY_ADDRESS,
        mockMongooseConnection,
        mockNatsClient,
      ),
    ).resolves.toBeNull();

    expect(mockPutObject).not.toBeCalled();
    expect(mockWasParcelCollected).toBeCalledWith(
      PARCEL,
      PRIVATE_GATEWAY_ADDRESS,
      mockMongooseConnection,
    );
  });

  test('The processing of the parcel should be recorded if successful', async () => {
    await store.storeEndpointBoundParcel(
      PARCEL,
      PARCEL_SERIALIZED,
      PRIVATE_GATEWAY_ADDRESS,
      mockMongooseConnection,
      mockNatsClient,
    );

    expect(mockRecordParcelCollection).toBeCalledWith(
      PARCEL,
      PRIVATE_GATEWAY_ADDRESS,
      mockMongooseConnection,
    );
  });

  test('Generated object key should be output', async () => {
    const key = await store.storeEndpointBoundParcel(
      PARCEL,
      PARCEL_SERIALIZED,
      PRIVATE_GATEWAY_ADDRESS,
      mockMongooseConnection,
      mockNatsClient,
    );

    const senderPrivateAddress = await PARCEL.senderCertificate.calculateSubjectPrivateAddress();
    const expectedKey = new RegExp(
      `^${PRIVATE_GATEWAY_ADDRESS}/${senderPrivateAddress}/[0-9a-f-]+$`,
    );
    expect(key).toMatch(expectedKey);
  });

  test('Object should be put in the right bucket', async () => {
    await store.storeEndpointBoundParcel(
      PARCEL,
      PARCEL_SERIALIZED,
      PRIVATE_GATEWAY_ADDRESS,
      mockMongooseConnection,
      mockNatsClient,
    );

    expect(mockPutObject).toBeCalledWith(expect.anything(), expect.anything(), BUCKET);
  });

  test('Parcel should be stored with generated object key', async () => {
    const key = await store.storeEndpointBoundParcel(
      PARCEL,
      PARCEL_SERIALIZED,
      PRIVATE_GATEWAY_ADDRESS,
      mockMongooseConnection,
      mockNatsClient,
    );

    expect(mockPutObject).toBeCalledWith(
      expect.anything(),
      `parcels/endpoint-bound/${key}`,
      expect.anything(),
    );
  });

  test('Parcel serialization should be stored', async () => {
    await store.storeEndpointBoundParcel(
      PARCEL,
      PARCEL_SERIALIZED,
      PRIVATE_GATEWAY_ADDRESS,
      mockMongooseConnection,
      mockNatsClient,
    );

    expect(mockPutObject).toBeCalledWith(
      expect.objectContaining({ body: PARCEL_SERIALIZED }),
      expect.anything(),
      expect.anything(),
    );
  });

  test('Parcel data should be published to right NATS Streaming channel', async () => {
    const key = await store.storeEndpointBoundParcel(
      PARCEL,
      PARCEL_SERIALIZED,
      PRIVATE_GATEWAY_ADDRESS,
      mockMongooseConnection,
      mockNatsClient,
    );

    const expectedMessageData: QueuedInternetBoundParcelMessage = {
      parcelExpiryDate: PARCEL.expiryDate,
      parcelObjectKey: key!!,
      parcelRecipientAddress: PARCEL.recipientAddress,
    };
    expect(mockNatsClient.publishMessage).toBeCalledWith(
      JSON.stringify(expectedMessageData),
      'internet-parcels',
    );
  });
});

describe('deleteEndpointBoundParcel', () => {
  const mockDeleteObject = mockSpy(jest.fn(), async () => ({ body: PARCEL_SERIALIZED }));
  const mockObjectStoreClient: ObjectStoreClient = { deleteObject: mockDeleteObject } as any;
  const store = new ParcelStore(mockObjectStoreClient, BUCKET);

  test('Object should be deleted from the right bucket', async () => {
    await store.deleteEndpointBoundParcel('');

    expect(mockDeleteObject).toBeCalledWith(expect.anything(), BUCKET);
  });

  test('Full object key should be prefixed', async () => {
    const key = 'thingy.parcel';
    await store.deleteEndpointBoundParcel(key);

    expect(mockDeleteObject).toBeCalledWith(`parcels/endpoint-bound/${key}`, expect.anything());
  });
});

describe('initFromEnv', () => {
  const requiredEnvVars = {
    OBJECT_STORE_BUCKET: 'the-bucket',
  };
  const mockEnvVars = configureMockEnvVars(requiredEnvVars);

  const mockObjectStoreClient = {};
  jest.spyOn(ObjectStoreClient, 'initFromEnv').mockReturnValue(mockObjectStoreClient as any);

  test('OBJECT_STORE_BUCKET should be required', () => {
    mockEnvVars({ ...requiredEnvVars, OBJECT_STORE_BUCKET: undefined });

    expect(() => ParcelStore.initFromEnv()).toThrowWithMessage(EnvVarError, /OBJECT_STORE_BUCKET/);
  });

  test('Parcel store should be returned', () => {
    const store = ParcelStore.initFromEnv();

    expect(store.bucket).toEqual(requiredEnvVars.OBJECT_STORE_BUCKET);
    expect(store.objectStoreClient).toBe(mockObjectStoreClient);
  });
});

function getTimestamp(date: Date): number {
  return Math.floor(date.getTime() / 1_000);
}
