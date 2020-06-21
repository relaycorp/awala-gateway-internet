// tslint:disable:no-let
import { Parcel } from '@relaycorp/relaynet-core';

import { arrayToAsyncIterable, asyncIterableToArray, mockPino, mockSpy } from '../_test_utils';
import { ObjectStoreClient, StoreObject } from '../backingServices/objectStorage';
import { generatePdaChain, sha256Hex } from './_test_utils';

const mockLogger = mockPino();
import { ParcelStore } from './parcelStore';

const BUCKET = 'the-bucket-name';

let PARCEL: Parcel;
let PARCEL_SERIALIZED: Buffer;
beforeAll(async () => {
  const pdaChain = await generatePdaChain();
  PARCEL = new Parcel('0deadbeef', pdaChain.pdaCert, Buffer.from([]));
  PARCEL_SERIALIZED = Buffer.from(await PARCEL.serialize(pdaChain.pdaGranteePrivateKey));
});

const PRIVATE_GATEWAY_ADDRESS = '0beefdead';

describe('retrieveActiveParcelsForGateway', () => {
  const mockGetObject = mockSpy(jest.fn());
  const mockListObjectKeys = mockSpy(jest.fn(), () => arrayToAsyncIterable([]));
  const mockObjectStoreClient: ObjectStoreClient = {
    getObject: mockGetObject,
    listObjectKeys: mockListObjectKeys,
  } as any;
  const store = new ParcelStore(mockObjectStoreClient, BUCKET);

  test('Parcels should be limited to those for the specified gateway', async () => {
    await asyncIterableToArray(store.retrieveActiveParcelsForGateway(PRIVATE_GATEWAY_ADDRESS));
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

    await asyncIterableToArray(store.retrieveActiveParcelsForGateway(PRIVATE_GATEWAY_ADDRESS));
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
      store.retrieveActiveParcelsForGateway(PRIVATE_GATEWAY_ADDRESS),
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
    mockGetObject.mockImplementation(objectKey => {
      if (objectKey !== parcelObjectKey) {
        throw new Error('That was deleted');
      }
      return {
        body: PARCEL_SERIALIZED,
        metadata: { 'parcel-expiry': getTimestampRelativeToNow(2) },
      };
    });

    const activeParcels = await asyncIterableToArray(
      store.retrieveActiveParcelsForGateway(PRIVATE_GATEWAY_ADDRESS),
    );
    expect(activeParcels).toEqual([{ expiryDate: expect.anything(), message: PARCEL_SERIALIZED }]);

    expect(mockLogger.warn).toBeCalledTimes(1);
    expect(mockLogger.warn).toBeCalledWith(
      { parcelObjectKey: deletedObjectKey },
      'Parcel object could not be found; it could have been deleted since keys were retrieved',
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
      store.retrieveActiveParcelsForGateway(PRIVATE_GATEWAY_ADDRESS),
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
      store.retrieveActiveParcelsForGateway(PRIVATE_GATEWAY_ADDRESS),
    );
    expect(activeParcels).toEqual([{ expiryDate: expect.anything(), message: PARCEL_SERIALIZED }]);

    expect(mockLogger.error).toBeCalledTimes(1);
    expect(mockLogger.error).toBeCalledWith(
      { parcelObjectKey: invalidParcelKey },
      'Parcel object does not have a valid expiry timestamp metadata',
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
      store.retrieveActiveParcelsForGateway(PRIVATE_GATEWAY_ADDRESS),
    );
    expect(activeParcels).toEqual([{ expiryDate: expect.anything(), message: PARCEL_SERIALIZED }]);

    expect(mockLogger.error).toBeCalledTimes(1);
    expect(mockLogger.error).toBeCalledWith(
      { parcelObjectKey: invalidParcelKey },
      'Parcel object does not have a valid expiry timestamp metadata',
    );
  });

  function setMockParcelObjectStore(objectsByKey: { readonly [key: string]: StoreObject }): void {
    mockListObjectKeys.mockReturnValue(arrayToAsyncIterable(Object.keys(objectsByKey)));
    mockGetObject.mockImplementation(objectKey => objectsByKey[objectKey]);
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

describe('storeGatewayBoundParcel', () => {
  const mockPutObject = mockSpy(jest.fn());
  const mockObjectStoreClient: ObjectStoreClient = { putObject: mockPutObject } as any;
  const store = new ParcelStore(mockObjectStoreClient, BUCKET);

  test('Full object key should be output', async () => {
    const objectKey = await store.storeGatewayBoundParcel(
      PARCEL,
      PARCEL_SERIALIZED,
      PRIVATE_GATEWAY_ADDRESS,
    );

    expect(mockPutObject).toBeCalledWith(expect.anything(), objectKey, expect.anything());
    expect(objectKey).toEqual(
      [
        'parcels',
        'gateway-bound',
        PRIVATE_GATEWAY_ADDRESS,
        PARCEL.recipientAddress,
        await PARCEL.senderCertificate.calculateSubjectPrivateAddress(),
        sha256Hex(PARCEL.id),
      ].join('/'),
    );
  });

  test('Object should be put in the right bucket', async () => {
    await store.storeGatewayBoundParcel(PARCEL, PARCEL_SERIALIZED, PRIVATE_GATEWAY_ADDRESS);

    expect(mockPutObject).toBeCalledWith(expect.anything(), expect.anything(), BUCKET);
  });

  test('Parcel expiry date should be stored as object metadata', async () => {
    await store.storeGatewayBoundParcel(PARCEL, PARCEL_SERIALIZED, PRIVATE_GATEWAY_ADDRESS);

    expect(mockPutObject).toBeCalledWith(
      expect.objectContaining({
        metadata: { ['parcel-expiry']: getTimestamp(PARCEL.expiryDate).toString() },
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  test('Parcel serialization should be stored', async () => {
    await store.storeGatewayBoundParcel(PARCEL, PARCEL_SERIALIZED, PRIVATE_GATEWAY_ADDRESS);

    expect(mockPutObject).toBeCalledWith(
      expect.objectContaining({ body: PARCEL_SERIALIZED }),
      expect.anything(),
      expect.anything(),
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

  test('Generated object key should be output', async () => {
    const key = await store.storeEndpointBoundParcel(PARCEL_SERIALIZED);

    expect(key).toMatch(/^[0-9a-f-]+$/);
  });

  test('Object should be put in the right bucket', async () => {
    await store.storeEndpointBoundParcel(PARCEL_SERIALIZED);

    expect(mockPutObject).toBeCalledWith(expect.anything(), expect.anything(), BUCKET);
  });

  test('Full object key should be prefixed', async () => {
    const key = await store.storeEndpointBoundParcel(PARCEL_SERIALIZED);

    expect(mockPutObject).toBeCalledWith(
      expect.anything(),
      `parcels/endpoint-bound/${key}`,
      expect.anything(),
    );
  });

  test('Parcel serialization should be stored', async () => {
    await store.storeEndpointBoundParcel(PARCEL_SERIALIZED);

    expect(mockPutObject).toBeCalledWith(
      expect.objectContaining({ body: PARCEL_SERIALIZED }),
      expect.anything(),
      expect.anything(),
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

function getTimestamp(date: Date): number {
  return Math.floor(date.getTime() / 1_000);
}
