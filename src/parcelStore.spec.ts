import { StoreObject } from '@relaycorp/object-storage';
import { InvalidMessageError, Parcel } from '@relaycorp/relaynet-core';
import AbortController from 'abort-controller';
import { EnvVarError } from 'env-var';
import pipe from 'it-pipe';
import { Connection } from 'mongoose';
import { Message } from 'node-nats-streaming';

import * as natsStreaming from './backingServices/natsStreaming';
import * as objectStorage from './backingServices/objectStorage';
import * as parcelCollection from './parcelCollection';
import {
  ParcelObject,
  ParcelObjectMetadata,
  ParcelStore,
  QueuedInternetBoundParcelMessage,
} from './parcelStore';
import * as pki from './pki';
import { sha256Hex } from './testUtils/crypto';
import { configureMockEnvVars } from './testUtils/envVars';
import { arrayToAsyncIterable, asyncIterableToArray, iterableTake } from './testUtils/iter';
import { getMockInstance, mockSpy } from './testUtils/jest';
import { makeMockLogging, MockLogging, partialPinoLog } from './testUtils/logging';
import {
  DeleteObjectArgs,
  GetObjectArgs,
  ListObjectKeysArgs,
} from './testUtils/objectStorage/args';
import {
  DeleteObjectCall,
  GetObjectCall,
  ListObjectKeysCall,
  PutObjectCall,
} from './testUtils/objectStorage/methodCalls';
import { MockObjectStore } from './testUtils/objectStorage/MockObjectStore';
import { generatePdaChain, PdaChain } from './testUtils/pki';
import { mockStanMessage } from './testUtils/stan';

const BUCKET = 'the-bucket-name';

let pdaChain: PdaChain;
let peerGatewayAddress: string;
beforeAll(async () => {
  pdaChain = await generatePdaChain();
  peerGatewayAddress = await pdaChain.privateGatewayCert.calculateSubjectPrivateAddress();
});

let parcel: Parcel;
let parcelSerialized: Buffer;
beforeAll(async () => {
  parcel = new Parcel(
    await pdaChain.peerEndpointCert.calculateSubjectPrivateAddress(),
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

let mockLogging: MockLogging;
beforeEach(() => {
  mockLogging = makeMockLogging();
});

describe('liveStreamActiveParcelsForGateway', () => {
  let abortController: AbortController;
  beforeEach(() => {
    abortController = new AbortController();
  });

  const activeParcelKey = 'prefix/active.parcel';
  let activeParcelObject: StoreObject;
  beforeAll(() => {
    activeParcelObject = {
      body: parcelSerialized,
      metadata: { 'parcel-expiry': getTimestamp(getDateRelativeToNow(10)).toString() },
    };
  });

  test('Active parcels should be streamed', async () => {
    mockParcelStanMessage(activeParcelKey);
    const objectStore = new MockObjectStore([new GetObjectCall(activeParcelObject)]);
    const parcelStore = new ParcelStore(objectStore, BUCKET);

    const activeParcels = pipe(
      parcelStore.liveStreamActiveParcelsForGateway(
        peerGatewayAddress,
        MOCK_NATS_CLIENT,
        abortController.signal,
        mockLogging.logger,
      ),
      iterableTake(1),
    );

    await expect(asyncIterableToArray(activeParcels)).resolves.toEqual([
      { ack: expect.any(Function), parcelObjectKey: activeParcelKey, parcelSerialized },
    ]);
  });

  test('Only key in message should be retrieved', async () => {
    mockParcelStanMessage(activeParcelKey);
    const getObjectCall = new GetObjectCall(activeParcelObject);
    const objectStore = new MockObjectStore([getObjectCall]);
    const parcelStore = new ParcelStore(objectStore, BUCKET);

    pipe(
      parcelStore.liveStreamActiveParcelsForGateway(
        peerGatewayAddress,
        MOCK_NATS_CLIENT,
        abortController.signal,
        mockLogging.logger,
      ),
      iterableTake(1),
    );

    expect(getObjectCall.wasCalled).toBeTrue();
    expect(getObjectCall.arguments).toEqual<GetObjectArgs>({
      bucket: BUCKET,
      key: activeParcelKey,
    });
  });

  test('Expired parcels should be filtered out', async () => {
    mockParcelStanMessage('prefix/expired.parcel');
    const objectStore = new MockObjectStore([
      new GetObjectCall({
        body: parcelSerialized,
        metadata: { 'parcel-expiry': getTimestamp(getDateRelativeToNow(0)).toString() },
      }),
    ]);
    const parcelStore = new ParcelStore(objectStore, BUCKET);

    const activeParcels = pipe(
      parcelStore.liveStreamActiveParcelsForGateway(
        peerGatewayAddress,
        MOCK_NATS_CLIENT,
        abortController.signal,
        mockLogging.logger,
      ),
      iterableTake(1),
    );

    await expect(asyncIterableToArray(activeParcels)).resolves.toHaveLength(0);
  });

  test('NATS subscription should be done with the right arguments', async () => {
    const parcelStore = new ParcelStore(new MockObjectStore([]), BUCKET);
    getMockInstance(MOCK_NATS_CLIENT.makeQueueConsumer).mockReturnValue(arrayToAsyncIterable([]));

    await asyncIterableToArray(
      parcelStore.liveStreamActiveParcelsForGateway(
        peerGatewayAddress,
        MOCK_NATS_CLIENT,
        abortController.signal,
        mockLogging.logger,
      ),
    );

    expect(MOCK_NATS_CLIENT.makeQueueConsumer).toBeCalledWith(
      `pdc-parcel.${peerGatewayAddress}`,
      'active-parcels',
      peerGatewayAddress,
      abortController.signal,
    );
  });

  describe('Acknowledgement callback', () => {
    test('NATS Streaming ack callback should be called', async () => {
      const stanMessage = mockParcelStanMessage(activeParcelKey);
      const objectStore = new MockObjectStore([new GetObjectCall(activeParcelObject)]);
      const parcelStore = new ParcelStore(objectStore, BUCKET);

      const [activeParcel] = await pipe(
        parcelStore.liveStreamActiveParcelsForGateway(
          peerGatewayAddress,
          MOCK_NATS_CLIENT,
          abortController.signal,
          mockLogging.logger,
        ),
        iterableTake(1),
        asyncIterableToArray,
      );

      await activeParcel.ack();

      expect(stanMessage.ack).toBeCalled();
    });

    test('Parcel should be deleted from store', async () => {
      mockParcelStanMessage(activeParcelKey);
      const deleteObjectCall = new DeleteObjectCall();
      const objectStore = new MockObjectStore([
        new GetObjectCall(activeParcelObject),
        deleteObjectCall,
      ]);
      const parcelStore = new ParcelStore(objectStore, BUCKET);

      const [activeParcel] = await pipe(
        parcelStore.liveStreamActiveParcelsForGateway(
          peerGatewayAddress,
          MOCK_NATS_CLIENT,
          abortController.signal,
          mockLogging.logger,
        ),
        iterableTake(1),
        asyncIterableToArray,
      );

      await activeParcel.ack();

      expect(deleteObjectCall.wasCalled).toBeTrue();
      expect(deleteObjectCall.arguments).toEqual<DeleteObjectArgs>({
        bucket: BUCKET,
        key: activeParcelKey,
      });
    });
  });

  function mockParcelStanMessage(objectKey: string): Message {
    const stanMessage = mockStanMessage(Buffer.from(objectKey));
    getMockInstance(MOCK_NATS_CLIENT.makeQueueConsumer).mockReturnValue(
      arrayToAsyncIterable([stanMessage]),
    );
    return stanMessage;
  }
});

describe('streamActiveParcelsForGateway', () => {
  let parcelObject: ParcelObject<null>;
  beforeEach(() => {
    parcelObject = {
      body: parcelSerialized,
      expiryDate: getDateRelativeToNow(1),
      extra: null,
      key: 'prefix/1.parcel',
    };
  });

  test('Only existing, active parcels should be retrieved', async () => {
    const parcelStore = new ParcelStore(new MockObjectStore([]), BUCKET);
    const parcelRetrieverSpy = jest
      .spyOn(parcelStore, 'retrieveActiveParcelsForGateway')
      .mockReturnValue(arrayToAsyncIterable([parcelObject]));

    const activeParcels = parcelStore.streamActiveParcelsForGateway(
      peerGatewayAddress,
      mockLogging.logger,
    );

    await expect(asyncIterableToArray(activeParcels)).resolves.toEqual([
      { ack: expect.any(Function), parcelObjectKey: parcelObject.key, parcelSerialized },
    ]);
    expect(parcelRetrieverSpy).toBeCalledWith(peerGatewayAddress, mockLogging.logger);
  });

  describe('Acknowledgement callback', () => {
    test('Parcel should be deleted from store when callback is called', async () => {
      const deleteObjectCall = new DeleteObjectCall();
      const objectStore = new MockObjectStore([deleteObjectCall]);
      const parcelStore = new ParcelStore(objectStore, BUCKET);
      jest
        .spyOn(parcelStore, 'retrieveActiveParcelsForGateway')
        .mockReturnValue(arrayToAsyncIterable([parcelObject]));

      const [message] = await asyncIterableToArray(
        parcelStore.streamActiveParcelsForGateway(peerGatewayAddress, mockLogging.logger),
      );

      expect(deleteObjectCall.wasCalled).toBeFalse();
      await message.ack();
      expect(deleteObjectCall.wasCalled).toBeTrue();
      expect(deleteObjectCall.arguments).toEqual<DeleteObjectArgs>({
        bucket: BUCKET,
        key: parcelObject.key,
      });
    });
  });
});

describe('retrieveActiveParcelsForGateway', () => {
  test('Parcels should be limited to those for the specified gateway', async () => {
    const listObjectKeysCall = new ListObjectKeysCall(arrayToAsyncIterable([]));
    const objectStore = new MockObjectStore([listObjectKeysCall]);
    const parcelStore = new ParcelStore(objectStore, BUCKET);

    await asyncIterableToArray(
      parcelStore.retrieveActiveParcelsForGateway(peerGatewayAddress, mockLogging.logger),
    );

    expect(listObjectKeysCall.wasCalled).toBeTrue();
    expect(listObjectKeysCall.arguments).toEqual<ListObjectKeysArgs>({
      bucket: BUCKET,
      prefix: `parcels/gateway-bound/${peerGatewayAddress}/`,
    });
  });

  test('Object retrieval should be limited to the specified bucket', async () => {
    const { getObjectCalls, objectStore } = makeMockObjectStore({
      'prefix/1.parcel': {
        body: parcelSerialized,
        metadata: { 'parcel-expiry': getTimestampRelativeToNow(1) },
      },
    });
    const parcelStore = new ParcelStore(objectStore, BUCKET);

    await asyncIterableToArray(
      parcelStore.retrieveActiveParcelsForGateway(peerGatewayAddress, mockLogging.logger),
    );

    expect(getObjectCalls[0].arguments?.bucket).toEqual(BUCKET);
  });

  test('Active parcels should be output', async () => {
    const parcel1Key = 'prefix/1.parcel';
    const parcel1ExpiryDate = getDateRelativeToNow(1);
    const parcel2Key = 'prefix/2.parcel';
    const parcel2ExpiryDate = getDateRelativeToNow(2);
    const parcel2Body = Buffer.from('Another parcel');
    const { objectStore } = makeMockObjectStore({
      [parcel1Key]: {
        body: parcelSerialized,
        metadata: { 'parcel-expiry': getTimestamp(parcel1ExpiryDate).toString() },
      },
      [parcel2Key]: {
        body: parcel2Body,
        metadata: { 'parcel-expiry': getTimestamp(parcel2ExpiryDate).toString() },
      },
    });
    const parcelStore = new ParcelStore(objectStore, BUCKET);

    const activeParcels = await asyncIterableToArray(
      parcelStore.retrieveActiveParcelsForGateway(peerGatewayAddress, mockLogging.logger),
    );

    expect(activeParcels).toEqual([
      { key: parcel1Key, expiryDate: parcel1ExpiryDate, body: parcelSerialized, extra: null },
      { key: parcel2Key, expiryDate: parcel2ExpiryDate, body: parcel2Body, extra: null },
    ]);
  });

  test('Expired parcels should be filtered out', async () => {
    const { objectStore } = makeMockObjectStore({
      'prefix/expired.parcel': {
        body: Buffer.from('Expired parcel'),
        metadata: { 'parcel-expiry': getTimestamp(getDateRelativeToNow(0)).toString() },
      },
    });
    const parcelStore = new ParcelStore(objectStore, BUCKET);

    await expect(
      asyncIterableToArray(
        parcelStore.retrieveActiveParcelsForGateway(peerGatewayAddress, mockLogging.logger),
      ),
    ).resolves.toHaveLength(0);
  });

  function makeMockObjectStore(objectsByKey: { readonly [key: string]: StoreObject }): {
    readonly getObjectCalls: readonly GetObjectCall[];
    readonly listObjectKeysCall: ListObjectKeysCall;
    readonly objectStore: MockObjectStore;
  } {
    const listObjectKeysCall = new ListObjectKeysCall(
      arrayToAsyncIterable(Object.keys(objectsByKey)),
    );
    const getObjectCalls = Object.values(objectsByKey).map((obj) => new GetObjectCall(obj));
    const objectStore = new MockObjectStore([listObjectKeysCall, ...getObjectCalls]);
    return { listObjectKeysCall, getObjectCalls, objectStore };
  }
});

describe('storeParcelFromPeerGateway', () => {
  const dummyObjectKey = 'the object key';

  test('Parcel should be bound for private gateway if recipient is private', async () => {
    const parcelStore = new ParcelStore(new MockObjectStore([]), BUCKET);
    const spiedStoreGatewayBoundParcel = jest
      .spyOn(parcelStore, 'storeGatewayBoundParcel')
      .mockImplementationOnce(async () => dummyObjectKey);

    // Make sure the shared fixture remains valid for this test:
    expect(parcel.isRecipientAddressPrivate).toBeTrue();

    await expect(
      parcelStore.storeParcelFromPeerGateway(
        parcel,
        parcelSerialized,
        await pdaChain.privateGatewayCert.calculateSubjectPrivateAddress(),
        MOCK_MONGOOSE_CONNECTION,
        MOCK_NATS_CLIENT,
        mockLogging.logger,
      ),
    ).resolves.toEqual(dummyObjectKey);

    expect(spiedStoreGatewayBoundParcel).toBeCalledWith(
      parcel,
      parcelSerialized,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );
  });

  test('Parcel should be bound for public endpoint if recipient is public', async () => {
    const parcelStore = new ParcelStore(new MockObjectStore([]), BUCKET);
    const spiedStoreEndpointBoundParcel = jest
      .spyOn(parcelStore, 'storeEndpointBoundParcel')
      .mockImplementationOnce(async () => dummyObjectKey);

    const parcelForPublicEndpoint = new Parcel(
      'https://endpoint.relaycorp.tech',
      pdaChain.pdaCert,
      Buffer.from([]),
      { senderCaCertificateChain: [pdaChain.peerEndpointCert, pdaChain.privateGatewayCert] },
    );
    const parcelForPublicEndpointSerialized = Buffer.from(
      await parcelForPublicEndpoint.serialize(pdaChain.pdaGranteePrivateKey),
    );

    await expect(
      parcelStore.storeParcelFromPeerGateway(
        parcelForPublicEndpoint,
        parcelForPublicEndpointSerialized,
        await pdaChain.privateGatewayCert.calculateSubjectPrivateAddress(),
        MOCK_MONGOOSE_CONNECTION,
        MOCK_NATS_CLIENT,
        mockLogging.logger,
      ),
    ).resolves.toEqual(dummyObjectKey);

    expect(spiedStoreEndpointBoundParcel).toBeCalledWith(
      parcelForPublicEndpoint,
      parcelForPublicEndpointSerialized,
      await pdaChain.privateGatewayCert.calculateSubjectPrivateAddress(),
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );
  });
});

describe('storeGatewayBoundParcel', () => {
  const mockRetrieveOwnCertificates = mockSpy(
    jest.spyOn(pki, 'retrieveOwnCertificates'),
    async () => [pdaChain.publicGatewayCert],
  );

  test('Parcel should be refused if sender is not trusted', async () => {
    const parcelStore = new ParcelStore(new MockObjectStore([]), BUCKET);
    const differentPDAChain = await generatePdaChain();
    mockRetrieveOwnCertificates.mockResolvedValue([differentPDAChain.publicGatewayCert]);

    await expect(
      parcelStore.storeGatewayBoundParcel(
        parcel,
        parcelSerialized,
        MOCK_MONGOOSE_CONNECTION,
        MOCK_NATS_CLIENT,
        mockLogging.logger,
      ),
    ).rejects.toBeInstanceOf(InvalidMessageError);
  });

  test('Debug log confirming validity of parcel should be recorded', async () => {
    const objectStore = new MockObjectStore([new PutObjectCall()]);
    const parcelStore = new ParcelStore(objectStore, BUCKET);

    await parcelStore.storeGatewayBoundParcel(
      parcel,
      parcelSerialized,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );

    expect(mockLogging.logs).toContainEqual(partialPinoLog('debug', 'Parcel is valid'));
  });

  test('Parcel object key should be output', async () => {
    const objectStore = new MockObjectStore([new PutObjectCall()]);
    const parcelStore = new ParcelStore(objectStore, BUCKET);

    const key = await parcelStore.storeGatewayBoundParcel(
      parcel,
      parcelSerialized,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );

    const expectedObjectKey = [
      'parcels',
      'gateway-bound',
      peerGatewayAddress,
      parcel.recipientAddress,
      await parcel.senderCertificate.calculateSubjectPrivateAddress(),
      sha256Hex(parcel.id),
    ].join('/');
    expect(key).toEqual(expectedObjectKey);
  });

  test('Parcel should be put in the right bucket', async () => {
    const putObjectCall = new PutObjectCall();
    const parcelStore = new ParcelStore(new MockObjectStore([putObjectCall]), BUCKET);

    await parcelStore.storeGatewayBoundParcel(
      parcel,
      parcelSerialized,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );

    expect(putObjectCall.wasCalled).toBeTrue();
    expect(putObjectCall.arguments?.bucket).toEqual(BUCKET);
  });

  test('Parcel object key should be unique for the parcel, sender and recipient', async () => {
    const putObjectCall = new PutObjectCall();
    const parcelStore = new ParcelStore(new MockObjectStore([putObjectCall]), BUCKET);

    const key = await parcelStore.storeGatewayBoundParcel(
      parcel,
      parcelSerialized,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );

    expect(putObjectCall.arguments?.key).toEqual(key);
  });

  test('Parcel serialization should be stored', async () => {
    const putObjectCall = new PutObjectCall();
    const parcelStore = new ParcelStore(new MockObjectStore([putObjectCall]), BUCKET);

    const parcelObjectKey = await parcelStore.storeGatewayBoundParcel(
      parcel,
      parcelSerialized,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );

    expect(putObjectCall.wasCalled).toBeTrue();
    expect(putObjectCall.arguments?.object.body).toEqual(parcelSerialized);
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('debug', 'Parcel object was stored successfully', { parcelObjectKey }),
    );
  });

  test('Parcel expiry date should be stored as object metadata', async () => {
    const putObjectCall = new PutObjectCall();
    const parcelStore = new ParcelStore(new MockObjectStore([putObjectCall]), BUCKET);

    await parcelStore.storeGatewayBoundParcel(
      parcel,
      parcelSerialized,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );

    expect(putObjectCall.arguments?.object.metadata).toEqual({
      ['parcel-expiry']: getTimestamp(parcel.expiryDate).toString(),
    });
  });

  test('Parcel object key should be published to right NATS Streaming channel', async () => {
    const objectStore = new MockObjectStore([new PutObjectCall()]);
    const parcelStore = new ParcelStore(objectStore, BUCKET);

    const parcelObjectKey = await parcelStore.storeGatewayBoundParcel(
      parcel,
      parcelSerialized,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );

    expect(MOCK_NATS_CLIENT.publishMessage).toBeCalledTimes(1);
    expect(MOCK_NATS_CLIENT.publishMessage).toBeCalledWith(
      parcelObjectKey,
      `pdc-parcel.${await pdaChain.privateGatewayCert.calculateSubjectPrivateAddress()}`,
    );
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('debug', 'Parcel storage was successfully published on NATS', {
        parcelObjectKey,
      }),
    );
  });
});

describe('deleteGatewayBoundParcel', () => {
  const store = new ParcelStore(mockObjectStoreClient, BUCKET);

  test('Object should be deleted from the right bucket', async () => {
    await store.deleteGatewayBoundParcel('', '', '', '');

    expect(mockObjectStoreClient.deleteObject).toBeCalledWith(expect.anything(), BUCKET);
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

    expect(mockObjectStoreClient.deleteObject).toBeCalledWith(
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
  const store = new ParcelStore(mockObjectStoreClient, BUCKET);

  beforeEach(() => {
    getMockInstance(mockObjectStoreClient.getObject).mockResolvedValue({
      body: parcelSerialized,
    });
  });

  test('Object should be retrieved from the right bucket', async () => {
    await store.retrieveEndpointBoundParcel('');

    expect(mockObjectStoreClient.getObject).toBeCalledWith(expect.anything(), BUCKET);
  });

  test('Lookup object key should be prefixed', async () => {
    const key = 'thingy.parcel';
    await store.retrieveEndpointBoundParcel(key);

    expect(mockObjectStoreClient.getObject).toBeCalledWith(
      `parcels/endpoint-bound/${key}`,
      expect.anything(),
    );
  });

  test('Parcel should be returned', async () => {
    const retrievedParcelSerialized = await store.retrieveEndpointBoundParcel('key');

    expect(retrievedParcelSerialized).toEqual(parcelSerialized);
  });

  test('Nothing should be returned if the object does not exist', async () => {
    getMockInstance(mockObjectStoreClient.getObject).mockResolvedValue(null);

    const retrievedParcelSerialized = await store.retrieveEndpointBoundParcel('key');

    expect(retrievedParcelSerialized).toBeNull();
  });
});

describe('storeEndpointBoundParcel', () => {
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
    const invalidParcelCreationDate = new Date();
    invalidParcelCreationDate.setSeconds(invalidParcelCreationDate.getSeconds() + 5);
    const invalidParcel = new Parcel(
      await pdaChain.peerEndpointCert.calculateSubjectPrivateAddress(),
      pdaChain.pdaCert,
      Buffer.from([]),
      { creationDate: invalidParcelCreationDate },
    );
    const invalidParcelSerialized = await invalidParcel.serialize(pdaChain.pdaGranteePrivateKey);

    await expect(
      store.storeEndpointBoundParcel(
        invalidParcel,
        Buffer.from(invalidParcelSerialized),
        peerGatewayAddress,
        MOCK_MONGOOSE_CONNECTION,
        MOCK_NATS_CLIENT,
        mockLogging.logger,
      ),
    ).rejects.toBeInstanceOf(InvalidMessageError);
    expect(mockObjectStoreClient.putObject).not.toBeCalled();
  });

  test('Debug log confirming validity of parcel should be recorded', async () => {
    await store.storeEndpointBoundParcel(
      parcel,
      parcelSerialized,
      peerGatewayAddress,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );

    expect(mockLogging.logs).toContainEqual(partialPinoLog('debug', 'Parcel is valid'));
  });

  test('Parcel should be ignored if it was already processed', async () => {
    mockWasParcelCollected.mockResolvedValue(true);

    await expect(
      store.storeEndpointBoundParcel(
        parcel,
        parcelSerialized,
        peerGatewayAddress,
        MOCK_MONGOOSE_CONNECTION,
        MOCK_NATS_CLIENT,
        mockLogging.logger,
      ),
    ).resolves.toBeNull();

    expect(mockObjectStoreClient.putObject).not.toBeCalled();
    expect(mockWasParcelCollected).toBeCalledWith(
      parcel,
      peerGatewayAddress,
      MOCK_MONGOOSE_CONNECTION,
    );
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('debug', 'Parcel was previously processed'),
    );
  });

  test('The processing of the parcel should be recorded if successful', async () => {
    await store.storeEndpointBoundParcel(
      parcel,
      parcelSerialized,
      peerGatewayAddress,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );

    expect(mockRecordParcelCollection).toBeCalledWith(
      parcel,
      peerGatewayAddress,
      MOCK_MONGOOSE_CONNECTION,
    );
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('debug', 'Parcel storage was successfully recorded'),
    );
  });

  test('Generated object key should be output', async () => {
    const key = await store.storeEndpointBoundParcel(
      parcel,
      parcelSerialized,
      peerGatewayAddress,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );

    const senderPrivateAddress = await parcel.senderCertificate.calculateSubjectPrivateAddress();
    const expectedKey = new RegExp(`^${peerGatewayAddress}/${senderPrivateAddress}/[0-9a-f-]+$`);
    expect(key).toMatch(expectedKey);
  });

  test('Object should be put in the right bucket', async () => {
    await store.storeEndpointBoundParcel(
      parcel,
      parcelSerialized,
      peerGatewayAddress,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );

    expect(mockObjectStoreClient.putObject).toBeCalledWith(
      expect.anything(),
      expect.anything(),
      BUCKET,
    );
  });

  test('Parcel should be stored with generated object key', async () => {
    const key = await store.storeEndpointBoundParcel(
      parcel,
      parcelSerialized,
      peerGatewayAddress,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );

    expect(mockObjectStoreClient.putObject).toBeCalledWith(
      expect.anything(),
      `parcels/endpoint-bound/${key}`,
      expect.anything(),
    );
  });

  test('Parcel serialization should be stored', async () => {
    const parcelObjectKey = await store.storeEndpointBoundParcel(
      parcel,
      parcelSerialized,
      peerGatewayAddress,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );

    expect(mockObjectStoreClient.putObject).toBeCalledWith(
      expect.objectContaining({ body: parcelSerialized }),
      expect.anything(),
      expect.anything(),
    );
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('debug', 'Parcel object was successfully stored', { parcelObjectKey }),
    );
  });

  test('Parcel data should be published to right NATS Streaming channel', async () => {
    const parcelObjectKey = await store.storeEndpointBoundParcel(
      parcel,
      parcelSerialized,
      peerGatewayAddress,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
      mockLogging.logger,
    );

    const expectedMessageData: QueuedInternetBoundParcelMessage = {
      deliveryAttempts: 0,
      parcelExpiryDate: parcel.expiryDate,
      parcelObjectKey: parcelObjectKey!!,
      parcelRecipientAddress: parcel.recipientAddress,
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

describe('deleteEndpointBoundParcel', () => {
  const store = new ParcelStore(mockObjectStoreClient, BUCKET);

  test('Object should be deleted from the right bucket', async () => {
    await store.deleteEndpointBoundParcel('');

    expect(mockObjectStoreClient.deleteObject).toBeCalledWith(expect.anything(), BUCKET);
  });

  test('Full object key should be prefixed', async () => {
    const key = 'thingy.parcel';
    await store.deleteEndpointBoundParcel(key);

    expect(mockObjectStoreClient.deleteObject).toBeCalledWith(
      `parcels/endpoint-bound/${key}`,
      expect.anything(),
    );
  });
});

describe('initFromEnv', () => {
  const requiredEnvVars = {
    OBJECT_STORE_BUCKET: 'the-bucket',
  };
  const mockEnvVars = configureMockEnvVars(requiredEnvVars);

  jest.spyOn(objectStorage, 'initObjectStoreFromEnv').mockReturnValue(mockObjectStoreClient);

  test('OBJECT_STORE_BUCKET should be required', () => {
    mockEnvVars({ ...requiredEnvVars, OBJECT_STORE_BUCKET: undefined });

    expect(() => ParcelStore.initFromEnv()).toThrowWithMessage(EnvVarError, /OBJECT_STORE_BUCKET/);
  });

  test('Parcel store should be returned', () => {
    const store = ParcelStore.initFromEnv();

    expect(store.bucket).toEqual(requiredEnvVars.OBJECT_STORE_BUCKET);
  });
});

describe('makeActiveParcelRetriever', () => {
  const store = new ParcelStore(mockObjectStoreClient, BUCKET);

  test('Active parcels should be output', async () => {
    const parcelObjectMetadata: ParcelObjectMetadata<{ readonly foo: string }> = {
      extra: { foo: 'bar' },
      key: 'prefix/active.parcel',
    };
    const expiryDate = getDateRelativeToNow(1);
    setMockParcelObjectStore({
      [parcelObjectMetadata.key]: {
        body: parcelSerialized,
        metadata: { 'parcel-expiry': getTimestamp(expiryDate).toString() },
      },
    });

    await expect(
      pipe(
        [parcelObjectMetadata],
        store.makeActiveParcelRetriever(mockLogging.logger),
        asyncIterableToArray,
      ),
    ).resolves.toEqual([{ ...parcelObjectMetadata, body: parcelSerialized, expiryDate }]);
  });

  test('Expired parcels should be filtered out', async () => {
    const parcelObjectMetadata: ParcelObjectMetadata<null> = {
      extra: null,
      key: 'prefix/expired.parcel',
    };
    const expiryDate = getDateRelativeToNow(0);
    setMockParcelObjectStore({
      [parcelObjectMetadata.key]: {
        body: parcelSerialized,
        metadata: { 'parcel-expiry': getTimestamp(expiryDate).toString() },
      },
    });

    await expect(
      pipe(
        [parcelObjectMetadata],
        store.makeActiveParcelRetriever(mockLogging.logger),
        asyncIterableToArray,
      ),
    ).resolves.toHaveLength(0);

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Ignoring expired parcel', {
        parcelExpiryDate: expiryDate.toISOString(),
        parcelObjectKey: parcelObjectMetadata.key,
      }),
    );
  });

  test('Objects without expiry metadata should be skipped and reported in the logs', async () => {
    const parcelObjectMetadata: ParcelObjectMetadata<null> = {
      extra: null,
      key: 'prefix/invalid.parcel',
    };
    setMockParcelObjectStore({
      [parcelObjectMetadata.key]: {
        body: parcelSerialized,
        metadata: {},
      },
    });

    await expect(
      pipe(
        [parcelObjectMetadata],
        store.makeActiveParcelRetriever(mockLogging.logger),
        asyncIterableToArray,
      ),
    ).resolves.toHaveLength(0);

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('warn', 'Parcel object does not have a valid expiry timestamp', {
        parcelObjectKey: parcelObjectMetadata.key,
      }),
    );
  });

  test('Objects whose expiry is not an integer should be skipped and reported in the logs', async () => {
    const parcelObjectMetadata: ParcelObjectMetadata<null> = {
      extra: null,
      key: 'prefix/invalid-expiry.parcel',
    };
    setMockParcelObjectStore({
      [parcelObjectMetadata.key]: {
        body: parcelSerialized,
        metadata: { 'parcel-expiry': 'I have seen many numbers in my life. This is not one.' },
      },
    });

    await expect(
      pipe(
        [parcelObjectMetadata],
        store.makeActiveParcelRetriever(mockLogging.logger),
        asyncIterableToArray,
      ),
    ).resolves.toHaveLength(0);

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('warn', 'Parcel object does not have a valid expiry timestamp', {
        parcelObjectKey: parcelObjectMetadata.key,
      }),
    );
  });

  test('Objects deleted since the listing should be gracefully skipped', async () => {
    const parcelObjectMetadata: ParcelObjectMetadata<null> = {
      extra: null,
      key: 'prefix/deleted.parcel',
    };
    getMockInstance(mockObjectStoreClient.getObject).mockResolvedValue(null);

    await expect(
      pipe(
        [parcelObjectMetadata],
        store.makeActiveParcelRetriever(mockLogging.logger),
        asyncIterableToArray,
      ),
    ).resolves.toHaveLength(0);

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog(
        'info',
        'Parcel object could not be found; it could have been deleted since keys were retrieved',
        {
          parcelObjectKey: parcelObjectMetadata.key,
        },
      ),
    );
  });

  function setMockParcelObjectStore(objectsByKey: { readonly [key: string]: StoreObject }): void {
    getMockInstance(mockObjectStoreClient.listObjectKeys).mockReturnValue(
      arrayToAsyncIterable(Object.keys(objectsByKey)),
    );

    getMockInstance(mockObjectStoreClient.getObject).mockImplementation(
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
