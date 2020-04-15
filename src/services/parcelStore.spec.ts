import { arrayToAsyncIterable, asyncIterableToArray, mockPino, mockSpy } from '../_test_utils';
import { ObjectStoreClient, StoreObject } from '../backingServices/objectStorage';

const mockLogger = mockPino();
import { ParcelStore } from './parcelStore';

const BUCKET = 'the-bucket-name';
const GATEWAY_ADDRESS = 'gateway-address';
const PARCEL_SERIALIZED = Buffer.from('The RAMF-serialized parcel');

describe('retrieveActiveParcelsForGateway', () => {
  const mockGetObject = mockSpy(jest.fn());
  const mockListObjectKeys = mockSpy(jest.fn(), () => arrayToAsyncIterable([]));
  const mockObjectStoreClient: ObjectStoreClient = {
    getObject: mockGetObject,
    listObjectKeys: mockListObjectKeys,
  } as any;
  const store = new ParcelStore(mockObjectStoreClient, BUCKET);

  test('Parcels should be limited to those for the specified gateway', async () => {
    await asyncIterableToArray(store.retrieveActiveParcelsForGateway(GATEWAY_ADDRESS));
    expect(mockListObjectKeys).toBeCalledTimes(1);
    expect(mockListObjectKeys).toBeCalledWith(
      `parcels/gateway-bound/${GATEWAY_ADDRESS}/`,
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

    await asyncIterableToArray(store.retrieveActiveParcelsForGateway(GATEWAY_ADDRESS));
    expect(mockListObjectKeys).toBeCalledTimes(1);
    expect(mockListObjectKeys).toBeCalledWith(expect.anything(), BUCKET);
    expect(mockGetObject).toBeCalledTimes(1);
    expect(mockGetObject).toBeCalledWith(expect.anything(), BUCKET);
  });

  test('Active parcels should be output', async () => {
    const objectsByKey: { readonly [key: string]: StoreObject } = {
      'prefix/1.parcel': {
        body: PARCEL_SERIALIZED,
        metadata: { 'parcel-expiry': getTimestampRelativeToNow(1) },
      },
      'prefix/2.parcel': {
        body: Buffer.from('Another parcel'),
        metadata: { 'parcel-expiry': getTimestampRelativeToNow(2) },
      },
    };
    setMockParcelObjectStore(objectsByKey);

    const activeParcels = await asyncIterableToArray(
      store.retrieveActiveParcelsForGateway(GATEWAY_ADDRESS),
    );

    expect(activeParcels).toEqual(Object.values(objectsByKey).map(obj => obj.body));
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
        metadata: { 'parcel-expiry': getTimestampRelativeToNow(1) },
      };
    });

    const activeParcels = await asyncIterableToArray(
      store.retrieveActiveParcelsForGateway(GATEWAY_ADDRESS),
    );
    expect(activeParcels).toEqual([PARCEL_SERIALIZED]);

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
      store.retrieveActiveParcelsForGateway(GATEWAY_ADDRESS),
    );
    expect(activeParcels).toEqual([PARCEL_SERIALIZED]);
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
      store.retrieveActiveParcelsForGateway(GATEWAY_ADDRESS),
    );
    expect(activeParcels).toEqual([PARCEL_SERIALIZED]);

    expect(mockLogger.error).toBeCalledTimes(1);
    expect(mockLogger.error).toBeCalledWith(
      { parcelObjectKey: invalidParcelKey },
      'Parcel object does not have expiry timestamp metadata',
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
      store.retrieveActiveParcelsForGateway(GATEWAY_ADDRESS),
    );
    expect(activeParcels).toEqual([PARCEL_SERIALIZED]);

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

  function getTimestampRelativeToNow(deltaSeconds: number): string {
    const date = new Date();
    date.setSeconds(date.getSeconds() + deltaSeconds, 0);
    return (date.getTime() / 1_000).toString();
  }
});
