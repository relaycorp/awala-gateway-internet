import { ObjectStoreClient, StoreObject } from '@relaycorp/object-storage';
import { InvalidMessageError, Parcel, Recipient } from '@relaycorp/relaynet-core';
import { EnvVarError } from 'env-var';
import { Connection } from 'mongoose';
import { collect, consume, pipeline } from 'streaming-iterables';

import * as natsStreaming from './backingServices/natsStreaming';
import * as objectStorage from './backingServices/objectStorage';
import * as parcelCollection from './parcelCollection';
import {
  ParcelObject,
  ParcelStore,
  ParcelStreamMessage,
  QueuedInternetBoundParcelMessage,
} from './parcelStore';
import * as pki from './pki';
import { GATEWAY_INTERNET_ADDRESS, PEER_INTERNET_ADDRESS } from './testUtils/awala';
import { sha256Hex } from './testUtils/crypto';
import { configureMockEnvVars } from './testUtils/envVars';
import { arrayToAsyncIterable, asyncIterableToArray, iterableTake } from './testUtils/iter';
import { getMockInstance, mockSpy } from './testUtils/jest';
import { makeMockLogging, MockLogging, partialPinoLog } from './testUtils/logging';
import { generatePdaChain, PdaChain } from './testUtils/pki';
import { mockRedisPubSubClient } from './testUtils/redis';
import { MockObjectStoreClient } from './testUtils/MockObjectStoreClient';
import { RedisPublishFunction } from './backingServices/RedisPubSubClient.js';

const BUCKET = 'the-bucket-name';

let pdaChain: PdaChain;
let parcelRecipient: Recipient;
let privateGatewayId: string;
beforeAll(async () => {
  pdaChain = await generatePdaChain();
  privateGatewayId = await pdaChain.privateGatewayCert.calculateSubjectId();
  parcelRecipient = { id: await pdaChain.peerEndpointCert.calculateSubjectId() };
});

let parcel: Parcel;
let parcelSerialized: Buffer;
beforeAll(async () => {
  parcel = new Parcel(
    { ...parcelRecipient, internetAddress: PEER_INTERNET_ADDRESS },
    pdaChain.pdaCert,
    Buffer.from([]),
    { senderCaCertificateChain: [pdaChain.peerEndpointCert, pdaChain.privateGatewayCert] },
  );
  parcelSerialized = Buffer.from(await parcel.serialize(pdaChain.pdaGranteePrivateKey));
});

const MOCK_NATS_CLIENT: natsStreaming.NatsStreamingClient = {
  makeQueueConsumer: mockSpy(jest.fn()),
  publishMessage: mockSpy(jest.fn()),
} as any;

const MOCK_MONGOOSE_CONNECTION: Connection = mockSpy(jest.fn()) as any;

const MOCK_OBJECT_STORE_CLIENT: ObjectStoreClient = {
  deleteObject: mockSpy(jest.fn(), async () => null),
  getObject: mockSpy(jest.fn()),
  listObjectKeys: mockSpy(jest.fn(), () => arrayToAsyncIterable([])),
  putObject: mockSpy(jest.fn()),
} as any;

let mockLogging: MockLogging;
beforeEach(() => {
  mockLogging = makeMockLogging();
});

const mockRedisPublish = mockSpy(jest.fn()) as unknown as RedisPublishFunction;

describe('liveStreamParcelsForPrivatePeer', () => {
  const objectStore = new MockObjectStoreClient();
  afterEach(() => objectStore.reset());

  const store = new ParcelStore(objectStore, BUCKET, GATEWAY_INTERNET_ADDRESS);

  let abortController: AbortController;
  beforeEach(() => {
    abortController = new AbortController();
  });

  const activeParcelKey = 'active.parcel';

  const redisPubSubClient = mockRedisPubSubClient();

  test('Pre-existing parcels should be streamed', async () => {
    const parcelMatch = await mockExistingParcel(
      activeParcelKey,
      makeParcelObject(parcelSerialized),
    );

    const [activeParcel] = await pipeline(
      () =>
        store.liveStreamParcelsForPrivatePeer(
          privateGatewayId,
          redisPubSubClient,
          abortController.signal,
          mockLogging.logger,
        ),
      iterableTake(1),
      collect,
    );

    expect(activeParcel).toStrictEqual(parcelMatch);
  });

  test('Expired parcels should be filtered out', async () => {
    await mockExistingParcel('expired.parcel', makeParcelObject(parcelSerialized, 0));
    const validParcelMatch = await mockExistingParcel(
      activeParcelKey,
      makeParcelObject(parcelSerialized),
    );

    const [activeParcel] = await pipeline(
      () =>
        store.liveStreamParcelsForPrivatePeer(
          privateGatewayId,
          redisPubSubClient,
          abortController.signal,
          mockLogging.logger,
        ),
      iterableTake(1),
      collect,
    );

    expect(activeParcel).toStrictEqual(validParcelMatch);
  });

  test('Messages from the private gateway Redis channel should be streamed', async () => {
    // Publish two parcels, but the first is going to a different private gateway
    mockIncomingParcel(
      'different-gateway.parcel',
      makeParcelObject(Buffer.from('Later...')),
      `not-${privateGatewayId}`,
    );
    const parcel = mockIncomingParcel(
      activeParcelKey,
      makeParcelObject(parcelSerialized),
      privateGatewayId,
    );

    const [activeParcel] = await pipeline(
      () =>
        store.liveStreamParcelsForPrivatePeer(
          privateGatewayId,
          redisPubSubClient,
          abortController.signal,
          mockLogging.logger,
        ),
      iterableTake(1),
      collect,
    );

    expect(activeParcel).toStrictEqual(parcel);
  });

  test('Pre-existing parcels should be output first', async () => {
    const existingParcel = await mockExistingParcel(
      activeParcelKey,
      makeParcelObject(parcelSerialized),
    );
    const incomingParcel = mockIncomingParcel(
      'prefix/2.parcel',
      makeParcelObject(Buffer.from('Later...')),
      privateGatewayId,
    );

    const activeParcels = await pipeline(
      () =>
        store.liveStreamParcelsForPrivatePeer(
          privateGatewayId,
          redisPubSubClient,
          abortController.signal,
          mockLogging.logger,
        ),
      iterableTake(2),
      collect,
    );

    expect(activeParcels).toStrictEqual([existingParcel, incomingParcel]);
  });

  test('Redis subscription should be terminated when abort signal is triggered', async () => {
    const abortController = new AbortController();
    await mockExistingParcel(activeParcelKey, makeParcelObject(parcelSerialized));

    await expect(
      pipeline(
        () =>
          store.liveStreamParcelsForPrivatePeer(
            privateGatewayId,
            redisPubSubClient,
            abortController.signal,
            mockLogging.logger,
          ),
        async (parcels: AsyncIterable<ParcelStreamMessage>) => {
          await Promise.all([
            consume(parcels),
            new Promise<void>((resolve) => {
              abortController.abort();
              resolve();
            }),
          ]);
        },
      ),
    ).toResolve();
  });

  describe('Acknowledgement callback', () => {
    test('Parcel should be deleted from store', async () => {
      await mockExistingParcel(activeParcelKey, makeParcelObject(parcelSerialized));
      const absoluteParcelKey = prefixParcelObjectKey(activeParcelKey);
      await expect(objectStore.getObject(absoluteParcelKey, BUCKET)).resolves.not.toBeNull();

      const [activeParcel] = await pipeline(
        () =>
          store.liveStreamParcelsForPrivatePeer(
            privateGatewayId,
            redisPubSubClient,
            abortController.signal,
            mockLogging.logger,
          ),
        iterableTake(1),
        collect,
      );

      await activeParcel.ack();

      await expect(objectStore.getObject(absoluteParcelKey, BUCKET)).resolves.toBeNull();
    });
  });

  function makeParcelObject(body: Buffer, expiryDelta = 10): StoreObject {
    const expiryDate = getDateRelativeToNow(expiryDelta);
    return {
      body,
      metadata: { 'parcel-expiry': getTimestamp(expiryDate).toString() },
    };
  }

  async function mockExistingParcel(key: string, parcel: StoreObject): Promise<jest.Expect> {
    const absoluteKey = prefixParcelObjectKey(key);
    await objectStore.putObject(parcel, absoluteKey, BUCKET);
    return makeStoreObjectMatch(absoluteKey, parcel.body);
  }

  function mockIncomingParcel(
    relativeKey: string,
    parcel: StoreObject,
    privateGatewayId: string,
  ): jest.Expect {
    const absoluteKey = prefixParcelObjectKey(relativeKey);
    setImmediate(async () => {
      await objectStore.putObject(parcel, absoluteKey, BUCKET);
      redisPubSubClient.mockPublish({
        channel: `pdc-parcel.${privateGatewayId}`,
        content: absoluteKey,
      });
    });
    return makeStoreObjectMatch(absoluteKey, parcel.body);
  }

  function prefixParcelObjectKey(parcelObjectKey: string): string {
    return `parcels/gateway-bound/${privateGatewayId}/${parcelObjectKey}`;
  }

  function makeStoreObjectMatch(parcelObjectKey: string, parcelSerialized: Buffer): jest.Expect {
    return expect.objectContaining({
      ack: expect.any(Function),
      parcelObjectKey,
      parcelSerialized,
    });
  }
});

describe('streamParcelsForPrivatePeer', () => {
  let parcelObject: ParcelObject;
  beforeEach(() => {
    parcelObject = {
      body: parcelSerialized,
      expiryDate: getDateRelativeToNow(1),
      key: 'prefix/1.parcel',
    };
  });

  test('Only existing, active parcels should be retrieved', async () => {
    const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET, GATEWAY_INTERNET_ADDRESS);
    const parcelRetrieverSpy = jest
      .spyOn(store, 'retrieveParcelsForPrivatePeer')
      .mockReturnValue(arrayToAsyncIterable([parcelObject]));

    const activeParcels = store.streamParcelsForPrivatePeer(privateGatewayId, mockLogging.logger);

    await expect(asyncIterableToArray(activeParcels)).resolves.toEqual([
      { ack: expect.any(Function), parcelObjectKey: parcelObject.key, parcelSerialized },
    ]);
    expect(parcelRetrieverSpy).toBeCalledWith(privateGatewayId, mockLogging.logger);
  });

  describe('Acknowledgement callback', () => {
    test('Parcel should be deleted from store when callback is called', async () => {
      const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET, GATEWAY_INTERNET_ADDRESS);
      jest
        .spyOn(store, 'retrieveParcelsForPrivatePeer')
        .mockReturnValue(arrayToAsyncIterable([parcelObject]));

      const [message] = await asyncIterableToArray(
        store.streamParcelsForPrivatePeer(privateGatewayId, mockLogging.logger),
      );

      expect(MOCK_OBJECT_STORE_CLIENT.deleteObject).not.toBeCalled();
      await message.ack();
      expect(MOCK_OBJECT_STORE_CLIENT.deleteObject).toBeCalledWith(parcelObject.key, BUCKET);
    });
  });
});

describe('retrieveParcelsForPrivatePeer', () => {
  const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET, GATEWAY_INTERNET_ADDRESS);

  test('Parcels should be limited to those for the specified gateway', async () => {
    await asyncIterableToArray(
      store.retrieveParcelsForPrivatePeer(privateGatewayId, mockLogging.logger),
    );
    expect(MOCK_OBJECT_STORE_CLIENT.listObjectKeys).toBeCalledTimes(1);
    expect(MOCK_OBJECT_STORE_CLIENT.listObjectKeys).toBeCalledWith(
      `parcels/gateway-bound/${privateGatewayId}/`,
      expect.anything(),
    );
  });

  test('Operations should be limited to the specified bucket', async () => {
    const objectsByKey = {
      'prefix/1.parcel': {
        body: parcelSerialized,
        metadata: { 'parcel-expiry': getTimestampRelativeToNow(1) },
      },
    };
    setMockParcelObjectStore(objectsByKey);

    await asyncIterableToArray(
      store.retrieveParcelsForPrivatePeer(privateGatewayId, mockLogging.logger),
    );
    expect(MOCK_OBJECT_STORE_CLIENT.listObjectKeys).toBeCalledTimes(1);
    expect(MOCK_OBJECT_STORE_CLIENT.listObjectKeys).toBeCalledWith(expect.anything(), BUCKET);
    expect(MOCK_OBJECT_STORE_CLIENT.getObject).toBeCalledTimes(1);
    expect(MOCK_OBJECT_STORE_CLIENT.getObject).toBeCalledWith(expect.anything(), BUCKET);
  });

  test('Active parcels should be output', async () => {
    const parcel1Key = 'prefix/1.parcel';
    const parcel1ExpiryDate = getDateRelativeToNow(1);
    const parcel2Key = 'prefix/2.parcel';
    const parcel2ExpiryDate = getDateRelativeToNow(2);
    const parcel2Body = Buffer.from('Another parcel');
    setMockParcelObjectStore({
      [parcel1Key]: {
        body: parcelSerialized,
        metadata: { 'parcel-expiry': getTimestamp(parcel1ExpiryDate).toString() },
      },
      [parcel2Key]: {
        body: parcel2Body,
        metadata: { 'parcel-expiry': getTimestamp(parcel2ExpiryDate).toString() },
      },
    });

    const activeParcels = await asyncIterableToArray(
      store.retrieveParcelsForPrivatePeer(privateGatewayId, mockLogging.logger),
    );

    expect(activeParcels).toEqual([
      { key: parcel1Key, expiryDate: parcel1ExpiryDate, body: parcelSerialized },
      { key: parcel2Key, expiryDate: parcel2ExpiryDate, body: parcel2Body },
    ]);
  });

  test('Expired parcels should be filtered out', async () => {
    setMockParcelObjectStore({
      'prefix/expired.parcel': {
        body: Buffer.from('Expired parcel'),
        metadata: { 'parcel-expiry': getTimestamp(getDateRelativeToNow(0)).toString() },
      },
    });

    await expect(
      asyncIterableToArray(
        store.retrieveParcelsForPrivatePeer(privateGatewayId, mockLogging.logger),
      ),
    ).resolves.toHaveLength(0);
  });

  function setMockParcelObjectStore(objectsByKey: { readonly [key: string]: StoreObject }): void {
    getMockInstance(MOCK_OBJECT_STORE_CLIENT.listObjectKeys).mockReturnValue(
      arrayToAsyncIterable(Object.keys(objectsByKey)),
    );
    getMockInstance(MOCK_OBJECT_STORE_CLIENT.getObject).mockImplementation(
      (objectKey) => objectsByKey[objectKey],
    );
  }
});

describe('storeParcelFromPrivatePeer', () => {
  const dummyObjectKey = 'the object key';

  test('Parcel should be routed to private gateway if recipient Internet address is missing', async () => {
    const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET, GATEWAY_INTERNET_ADDRESS);
    const spiedStoreParcelForPrivatePeer = jest
      .spyOn(store, 'storeParcelForPrivatePeer')
      .mockImplementationOnce(async () => dummyObjectKey);
    const parcelForPrivateGateway = new Parcel(parcelRecipient, pdaChain.pdaCert, Buffer.from([]), {
      senderCaCertificateChain: [pdaChain.peerEndpointCert, pdaChain.privateGatewayCert],
    });
    const parcelForPrivateGatewaySerialized = Buffer.from(
      await parcelForPrivateGateway.serialize(pdaChain.pdaGranteePrivateKey),
    );

    await expect(
      store.storeParcelFromPrivatePeer(
        parcelForPrivateGateway,
        parcelForPrivateGatewaySerialized,
        privateGatewayId,
        MOCK_MONGOOSE_CONNECTION,
        MOCK_NATS_CLIENT,
        mockRedisPublish,
        mockLogging.logger,
      ),
    ).resolves.toEqual(dummyObjectKey);

    expect(spiedStoreParcelForPrivatePeer).toBeCalledWith(
      parcelForPrivateGateway,
      parcelForPrivateGatewaySerialized,
      MOCK_MONGOOSE_CONNECTION,
      mockRedisPublish,
      mockLogging.logger,
    );
  });

  test('Parcel should be routed to private gateway if recipient served by current Internet gateway', async () => {
    const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET, GATEWAY_INTERNET_ADDRESS);
    const spiedStoreParcelForPrivatePeer = jest
      .spyOn(store, 'storeParcelForPrivatePeer')
      .mockImplementationOnce(async () => dummyObjectKey);
    const parcelForPrivateGateway = new Parcel(
      { ...parcelRecipient, internetAddress: GATEWAY_INTERNET_ADDRESS },
      pdaChain.pdaCert,
      Buffer.from([]),
      { senderCaCertificateChain: [pdaChain.peerEndpointCert, pdaChain.privateGatewayCert] },
    );
    const parcelForPrivateGatewaySerialized = Buffer.from(
      await parcelForPrivateGateway.serialize(pdaChain.pdaGranteePrivateKey),
    );

    await expect(
      store.storeParcelFromPrivatePeer(
        parcelForPrivateGateway,
        parcelForPrivateGatewaySerialized,
        privateGatewayId,
        MOCK_MONGOOSE_CONNECTION,
        MOCK_NATS_CLIENT,
        mockRedisPublish,
        mockLogging.logger,
      ),
    ).resolves.toEqual(dummyObjectKey);

    expect(spiedStoreParcelForPrivatePeer).toBeCalledWith(
      parcelForPrivateGateway,
      parcelForPrivateGatewaySerialized,
      MOCK_MONGOOSE_CONNECTION,
      mockRedisPublish,
      mockLogging.logger,
    );
  });

  test('Parcel should be routed to Internet peer if recipient is served by different Internet gateway', async () => {
    const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET, GATEWAY_INTERNET_ADDRESS);
    const spiedStoreParcelForInternetPeer = jest
      .spyOn(store, 'storeParcelForInternetPeer')
      .mockImplementationOnce(async () => dummyObjectKey);

    const parcelForPublicEndpoint = new Parcel(
      { ...parcelRecipient, internetAddress: PEER_INTERNET_ADDRESS },
      pdaChain.pdaCert,
      Buffer.from([]),
      { senderCaCertificateChain: [pdaChain.peerEndpointCert, pdaChain.privateGatewayCert] },
    );
    const parcelForPublicEndpointSerialized = Buffer.from(
      await parcelForPublicEndpoint.serialize(pdaChain.pdaGranteePrivateKey),
    );

    await expect(
      store.storeParcelFromPrivatePeer(
        parcelForPublicEndpoint,
        parcelForPublicEndpointSerialized,
        privateGatewayId,
        MOCK_MONGOOSE_CONNECTION,
        MOCK_NATS_CLIENT,
        mockRedisPublish,
        mockLogging.logger,
      ),
    ).resolves.toEqual(dummyObjectKey);

    expect(spiedStoreParcelForInternetPeer).toBeCalledWith(
      parcelForPublicEndpoint,
      parcelForPublicEndpointSerialized,
      privateGatewayId,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );
  });
});

describe('storeParcelForPrivatePeer', () => {
  const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET, GATEWAY_INTERNET_ADDRESS);

  const mockRetrieveOwnCertificates = mockSpy(
    jest.spyOn(pki, 'retrieveOwnCertificates'),
    async () => [pdaChain.internetGatewayCert],
  );

  test('Parcel should be refused if sender is not trusted', async () => {
    const differentPDAChain = await generatePdaChain();
    mockRetrieveOwnCertificates.mockResolvedValue([differentPDAChain.internetGatewayCert]);

    await expect(
      store.storeParcelForPrivatePeer(
        parcel,
        parcelSerialized,
        MOCK_MONGOOSE_CONNECTION,
        mockRedisPublish,
        mockLogging.logger,
      ),
    ).rejects.toBeInstanceOf(InvalidMessageError);
    expect(MOCK_OBJECT_STORE_CLIENT.putObject).not.toBeCalled();
  });

  test('Debug log confirming validity of parcel should be recorded', async () => {
    await store.storeParcelForPrivatePeer(
      parcel,
      parcelSerialized,
      MOCK_MONGOOSE_CONNECTION,
      mockRedisPublish,
      mockLogging.logger,
    );

    expect(mockLogging.logs).toContainEqual(partialPinoLog('debug', 'Parcel is valid'));
  });

  test('Parcel object key should be output', async () => {
    const key = await store.storeParcelForPrivatePeer(
      parcel,
      parcelSerialized,
      MOCK_MONGOOSE_CONNECTION,
      mockRedisPublish,
      mockLogging.logger,
    );

    const expectedObjectKey = [
      'parcels',
      'gateway-bound',
      privateGatewayId,
      parcel.recipient.id,
      await parcel.senderCertificate.calculateSubjectId(),
      sha256Hex(parcel.id),
    ].join('/');
    expect(key).toEqual(expectedObjectKey);
  });

  test('Parcel should be put in the right bucket', async () => {
    await store.storeParcelForPrivatePeer(
      parcel,
      parcelSerialized,
      MOCK_MONGOOSE_CONNECTION,
      mockRedisPublish,
      mockLogging.logger,
    );

    expect(MOCK_OBJECT_STORE_CLIENT.putObject).toBeCalledWith(
      expect.anything(),
      expect.anything(),
      BUCKET,
    );
  });

  test('Parcel expiry date should be stored as object metadata', async () => {
    await store.storeParcelForPrivatePeer(
      parcel,
      parcelSerialized,
      MOCK_MONGOOSE_CONNECTION,
      mockRedisPublish,
      mockLogging.logger,
    );

    expect(MOCK_OBJECT_STORE_CLIENT.putObject).toBeCalledWith(
      expect.objectContaining({
        metadata: { ['parcel-expiry']: getTimestamp(parcel.expiryDate).toString() },
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  test('Parcel serialization should be stored', async () => {
    const parcelObjectKey = await store.storeParcelForPrivatePeer(
      parcel,
      parcelSerialized,
      MOCK_MONGOOSE_CONNECTION,
      mockRedisPublish,
      mockLogging.logger,
    );

    expect(MOCK_OBJECT_STORE_CLIENT.putObject).toBeCalledWith(
      expect.objectContaining({ body: parcelSerialized }),
      expect.anything(),
      expect.anything(),
    );
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('debug', 'Parcel object was stored successfully', { parcelObjectKey }),
    );
  });

  test('Parcel object key should be unique for the parcel, sender and recipient', async () => {
    const key = await store.storeParcelForPrivatePeer(
      parcel,
      parcelSerialized,
      MOCK_MONGOOSE_CONNECTION,
      mockRedisPublish,
      mockLogging.logger,
    );

    expect(MOCK_OBJECT_STORE_CLIENT.putObject).toBeCalledWith(
      expect.anything(),
      key,
      expect.anything(),
    );
  });

  test('Parcel object key should be published to right Red PubSub channel', async () => {
    const parcelObjectKey = await store.storeParcelForPrivatePeer(
      parcel,
      parcelSerialized,
      MOCK_MONGOOSE_CONNECTION,
      mockRedisPublish,
      mockLogging.logger,
    );

    expect(mockRedisPublish).toBeCalledTimes(1);
    expect(mockRedisPublish).toBeCalledWith(parcelObjectKey, `pdc-parcel.${privateGatewayId}`);
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('debug', 'Parcel storage was successfully published on Redis PubSub', {
        parcelObjectKey,
      }),
    );
  });
});

describe('deleteParcelForPrivatePeer', () => {
  const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET, GATEWAY_INTERNET_ADDRESS);

  test('Object should be deleted from the right bucket', async () => {
    await store.deleteParcelForPrivatePeer('', '', '', '');

    expect(MOCK_OBJECT_STORE_CLIENT.deleteObject).toBeCalledWith(expect.anything(), BUCKET);
  });

  test('Full object key should be prefixed', async () => {
    const parcelId = 'thingy.parcel';
    const senderId = '0deadbeef';
    const recipientId = '0deadc0de';
    const recipientGatewayId = '0beef';
    await store.deleteParcelForPrivatePeer(parcelId, senderId, recipientId, recipientGatewayId);

    expect(MOCK_OBJECT_STORE_CLIENT.deleteObject).toBeCalledWith(
      [
        'parcels/gateway-bound',
        recipientGatewayId,
        recipientId,
        senderId,
        sha256Hex(parcelId),
      ].join('/'),
      expect.anything(),
    );
  });
});

describe('retrieveParcelForInternetPeer', () => {
  const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET, GATEWAY_INTERNET_ADDRESS);

  beforeEach(() => {
    getMockInstance(MOCK_OBJECT_STORE_CLIENT.getObject).mockResolvedValue({
      body: parcelSerialized,
    });
  });

  test('Object should be retrieved from the right bucket', async () => {
    await store.retrieveParcelForInternetPeer('');

    expect(MOCK_OBJECT_STORE_CLIENT.getObject).toBeCalledWith(expect.anything(), BUCKET);
  });

  test('Lookup object key should be prefixed', async () => {
    const key = 'thingy.parcel';
    await store.retrieveParcelForInternetPeer(key);

    expect(MOCK_OBJECT_STORE_CLIENT.getObject).toBeCalledWith(
      `parcels/endpoint-bound/${key}`,
      expect.anything(),
    );
  });

  test('Parcel should be returned', async () => {
    const retrievedParcelSerialized = await store.retrieveParcelForInternetPeer('key');

    expect(retrievedParcelSerialized).toEqual(parcelSerialized);
  });

  test('Nothing should be returned if the object does not exist', async () => {
    getMockInstance(MOCK_OBJECT_STORE_CLIENT.getObject).mockResolvedValue(null);

    const retrievedParcelSerialized = await store.retrieveParcelForInternetPeer('key');

    expect(retrievedParcelSerialized).toBeNull();
  });
});

describe('storeParcelForInternetPeer', () => {
  const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET, GATEWAY_INTERNET_ADDRESS);

  const mockWasParcelCollected = mockSpy(
    jest.spyOn(parcelCollection, 'wasParcelCollected'),
    () => false,
  );
  const mockRecordParcelCollection = mockSpy(
    jest.spyOn(parcelCollection, 'recordParcelCollection'),
    () => undefined,
  );

  test('Parcel should be refused if it is invalid', async () => {
    const invalidParcelCreationDate = new Date();
    invalidParcelCreationDate.setSeconds(invalidParcelCreationDate.getSeconds() + 5);
    const invalidParcel = new Parcel(parcelRecipient, pdaChain.pdaCert, Buffer.from([]), {
      creationDate: invalidParcelCreationDate,
    });
    const invalidParcelSerialized = await invalidParcel.serialize(pdaChain.pdaGranteePrivateKey);

    await expect(
      store.storeParcelForInternetPeer(
        invalidParcel,
        Buffer.from(invalidParcelSerialized),
        privateGatewayId,
        MOCK_MONGOOSE_CONNECTION,
        MOCK_NATS_CLIENT,
        mockLogging.logger,
      ),
    ).rejects.toBeInstanceOf(InvalidMessageError);
    expect(MOCK_OBJECT_STORE_CLIENT.putObject).not.toBeCalled();
  });

  test('Debug log confirming validity of parcel should be recorded', async () => {
    await store.storeParcelForInternetPeer(
      parcel,
      parcelSerialized,
      privateGatewayId,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );

    expect(mockLogging.logs).toContainEqual(partialPinoLog('debug', 'Parcel is valid'));
  });

  test('Parcel should be ignored if it was already processed', async () => {
    mockWasParcelCollected.mockResolvedValue(true);

    await expect(
      store.storeParcelForInternetPeer(
        parcel,
        parcelSerialized,
        privateGatewayId,
        MOCK_MONGOOSE_CONNECTION,
        MOCK_NATS_CLIENT,
        mockLogging.logger,
      ),
    ).resolves.toBeNull();

    expect(MOCK_OBJECT_STORE_CLIENT.putObject).not.toBeCalled();
    expect(mockWasParcelCollected).toBeCalledWith(
      parcel,
      privateGatewayId,
      MOCK_MONGOOSE_CONNECTION,
    );
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('debug', 'Parcel was previously processed'),
    );
  });

  test('The processing of the parcel should be recorded if successful', async () => {
    await store.storeParcelForInternetPeer(
      parcel,
      parcelSerialized,
      privateGatewayId,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );

    expect(mockRecordParcelCollection).toBeCalledWith(
      parcel,
      privateGatewayId,
      MOCK_MONGOOSE_CONNECTION,
    );
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('debug', 'Parcel storage was successfully recorded'),
    );
  });

  test('Generated object key should be output', async () => {
    const key = await store.storeParcelForInternetPeer(
      parcel,
      parcelSerialized,
      privateGatewayId,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );

    const senderId = await parcel.senderCertificate.calculateSubjectId();
    const expectedKey = [
      privateGatewayId,
      senderId,
      parcel.recipient.id,
      sha256Hex(parcel.id),
    ].join('/');
    expect(key).toMatch(expectedKey);
  });

  test('Object should be put in the right bucket', async () => {
    await store.storeParcelForInternetPeer(
      parcel,
      parcelSerialized,
      privateGatewayId,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );

    expect(MOCK_OBJECT_STORE_CLIENT.putObject).toBeCalledWith(
      expect.anything(),
      expect.anything(),
      BUCKET,
    );
  });

  test('Parcel should be stored with generated object key', async () => {
    const key = await store.storeParcelForInternetPeer(
      parcel,
      parcelSerialized,
      privateGatewayId,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );

    expect(MOCK_OBJECT_STORE_CLIENT.putObject).toBeCalledWith(
      expect.anything(),
      `parcels/endpoint-bound/${key}`,
      expect.anything(),
    );
  });

  test('Parcel serialization should be stored', async () => {
    const parcelObjectKey = await store.storeParcelForInternetPeer(
      parcel,
      parcelSerialized,
      privateGatewayId,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );

    expect(MOCK_OBJECT_STORE_CLIENT.putObject).toBeCalledWith(
      expect.objectContaining({ body: parcelSerialized }),
      expect.anything(),
      expect.anything(),
    );
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('debug', 'Parcel object was successfully stored', { parcelObjectKey }),
    );
  });

  test('Parcel data should be published to right NATS Streaming channel', async () => {
    const parcelObjectKey = await store.storeParcelForInternetPeer(
      parcel,
      parcelSerialized,
      privateGatewayId,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );

    const expectedMessageData: QueuedInternetBoundParcelMessage = {
      deliveryAttempts: 0,
      parcelExpiryDate: parcel.expiryDate,
      parcelId: parcel.id,
      parcelObjectKey: parcelObjectKey!!,
      parcelRecipientAddress: PEER_INTERNET_ADDRESS,
    };
    expect(MOCK_NATS_CLIENT.publishMessage).toBeCalledWith(
      JSON.stringify(expectedMessageData),
      'internet-parcels',
    );
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('debug', 'Parcel storage was successfully published on NATS', {
        parcelObjectKey,
      }),
    );
  });
});

describe('deleteParcelForInternetPeer', () => {
  const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET, GATEWAY_INTERNET_ADDRESS);

  test('Object should be deleted from the right bucket', async () => {
    await store.deleteParcelForInternetPeer('');

    expect(MOCK_OBJECT_STORE_CLIENT.deleteObject).toBeCalledWith(expect.anything(), BUCKET);
  });

  test('Full object key should be prefixed', async () => {
    const key = 'thingy.parcel';
    await store.deleteParcelForInternetPeer(key);

    expect(MOCK_OBJECT_STORE_CLIENT.deleteObject).toBeCalledWith(
      `parcels/endpoint-bound/${key}`,
      expect.anything(),
    );
  });
});

describe('initFromEnv', () => {
  const requiredEnvVars = {
    OBJECT_STORE_BUCKET: 'the-bucket',
    PUBLIC_ADDRESS: GATEWAY_INTERNET_ADDRESS,
  };
  const mockEnvVars = configureMockEnvVars(requiredEnvVars);

  jest.spyOn(objectStorage, 'initObjectStoreFromEnv').mockReturnValue(MOCK_OBJECT_STORE_CLIENT);

  test.each(Object.keys(requiredEnvVars))('%s should be required', (envVar) => {
    mockEnvVars({ ...requiredEnvVars, [envVar]: undefined });

    expect(() => ParcelStore.initFromEnv()).toThrowWithMessage(EnvVarError, new RegExp(envVar));
  });

  test('Parcel store should be returned', () => {
    const store = ParcelStore.initFromEnv();

    expect(store.bucket).toEqual(requiredEnvVars.OBJECT_STORE_BUCKET);
    expect(store.objectStoreClient).toBe(MOCK_OBJECT_STORE_CLIENT);
    expect(store.internetAddress).toBe(GATEWAY_INTERNET_ADDRESS);
  });
});

describe('makeActiveParcelRetriever', () => {
  const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET, GATEWAY_INTERNET_ADDRESS);

  test('Active parcels should be output', async () => {
    const parcelObjectKey = 'prefix/active.parcel';
    const expiryDate = getDateRelativeToNow(1);
    setMockParcelObjectStore({
      [parcelObjectKey]: {
        body: parcelSerialized,
        metadata: { 'parcel-expiry': getTimestamp(expiryDate).toString() },
      },
    });

    await expect(
      pipeline(
        () => arrayToAsyncIterable([parcelObjectKey]),
        store.makeActiveParcelRetriever(mockLogging.logger),
        asyncIterableToArray,
      ),
    ).resolves.toEqual([{ key: parcelObjectKey, body: parcelSerialized, expiryDate }]);
  });

  test('Expired parcels should be filtered out', async () => {
    const parcelObjectKey = 'prefix/expired.parcel';
    const expiryDate = getDateRelativeToNow(0);
    setMockParcelObjectStore({
      [parcelObjectKey]: {
        body: parcelSerialized,
        metadata: { 'parcel-expiry': getTimestamp(expiryDate).toString() },
      },
    });

    await expect(
      pipeline(
        () => arrayToAsyncIterable([parcelObjectKey]),
        store.makeActiveParcelRetriever(mockLogging.logger),
        asyncIterableToArray,
      ),
    ).resolves.toHaveLength(0);

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Ignoring expired parcel', {
        parcelExpiryDate: expiryDate.toISOString(),
        parcelObjectKey,
      }),
    );
  });

  test('Objects without expiry metadata should be skipped and reported in the logs', async () => {
    const parcelObjectKey = 'prefix/invalid.parcel';
    setMockParcelObjectStore({
      [parcelObjectKey]: {
        body: parcelSerialized,
        metadata: {},
      },
    });

    await expect(
      pipeline(
        () => arrayToAsyncIterable([parcelObjectKey]),
        store.makeActiveParcelRetriever(mockLogging.logger),
        asyncIterableToArray,
      ),
    ).resolves.toHaveLength(0);

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('warn', 'Parcel object does not have a valid expiry timestamp', {
        parcelObjectKey,
      }),
    );
  });

  test('Objects whose expiry is not an integer should be skipped and reported in the logs', async () => {
    const parcelObjectKey = 'prefix/invalid-expiry.parcel';
    setMockParcelObjectStore({
      [parcelObjectKey]: {
        body: parcelSerialized,
        metadata: { 'parcel-expiry': 'I have seen many numbers in my life. This is not one.' },
      },
    });

    await expect(
      pipeline(
        () => arrayToAsyncIterable([parcelObjectKey]),
        store.makeActiveParcelRetriever(mockLogging.logger),
        asyncIterableToArray,
      ),
    ).resolves.toHaveLength(0);

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('warn', 'Parcel object does not have a valid expiry timestamp', {
        parcelObjectKey,
      }),
    );
  });

  test('Objects deleted since the listing should be gracefully skipped', async () => {
    const parcelObjectKey = 'prefix/deleted.parcel';
    getMockInstance(MOCK_OBJECT_STORE_CLIENT.getObject).mockResolvedValue(null);

    await expect(
      pipeline(
        () => arrayToAsyncIterable([parcelObjectKey]),
        store.makeActiveParcelRetriever(mockLogging.logger),
        asyncIterableToArray,
      ),
    ).resolves.toHaveLength(0);

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog(
        'info',
        'Parcel object could not be found; it could have been deleted since keys were retrieved',
        { parcelObjectKey },
      ),
    );
  });

  function setMockParcelObjectStore(objectsByKey: { readonly [key: string]: StoreObject }): void {
    getMockInstance(MOCK_OBJECT_STORE_CLIENT.listObjectKeys).mockReturnValue(
      arrayToAsyncIterable(Object.keys(objectsByKey)),
    );

    getMockInstance(MOCK_OBJECT_STORE_CLIENT.getObject).mockImplementation(
      (objectKey) => objectsByKey[objectKey],
    );
  }
});

function getDateRelativeToNow(deltaSeconds: number): Date {
  const date = new Date();
  date.setSeconds(date.getSeconds() + deltaSeconds, 0);
  return date;
}

function getTimestampRelativeToNow(deltaSeconds: number): string {
  const date = getDateRelativeToNow(deltaSeconds);
  return getTimestamp(date).toString();
}

function getTimestamp(date: Date): number {
  return Math.floor(date.getTime() / 1_000);
}
