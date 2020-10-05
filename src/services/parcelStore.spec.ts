// tslint:disable:no-let

import { InvalidMessageError, Parcel } from '@relaycorp/relaynet-core';
import AbortController from 'abort-controller';
import { EnvVarError } from 'env-var';
import pipe from 'it-pipe';
import { Connection } from 'mongoose';
import { Message } from 'node-nats-streaming';

import {
  arrayToAsyncIterable,
  asyncIterableToArray,
  iterableTake,
  makeMockLogging,
  MockLogging,
  mockSpy,
  partialPinoLog,
  PdaChain,
  sha256Hex,
} from '../_test_utils';
import * as natsStreaming from '../backingServices/natsStreaming';
import { ObjectStoreClient, StoreObject } from '../backingServices/objectStorage';
import {
  configureMockEnvVars,
  generatePdaChain,
  getMockInstance,
  mockStanMessage,
} from './_test_utils';
import * as certs from './certs';
import * as parcelCollection from './parcelCollection';
import {
  ParcelObject,
  ParcelObjectMetadata,
  ParcelStore,
  QueuedInternetBoundParcelMessage,
} from './parcelStore';

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

describe('liveStreamActiveParcelsForGateway', () => {
  const STORE = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET);

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
    setMockParcelObjectStore(activeParcelObject, activeParcelKey);

    const activeParcels = pipe(
      STORE.liveStreamActiveParcelsForGateway(
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

  test('Expired parcels should be filtered out', async () => {
    setMockParcelObjectStore(
      {
        body: parcelSerialized,
        metadata: { 'parcel-expiry': getTimestamp(getDateRelativeToNow(0)).toString() },
      },
      'prefix/expired.parcel',
    );

    const activeParcels = pipe(
      STORE.liveStreamActiveParcelsForGateway(
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
    getMockInstance(MOCK_NATS_CLIENT.makeQueueConsumer).mockReturnValue(arrayToAsyncIterable([]));

    await asyncIterableToArray(
      STORE.liveStreamActiveParcelsForGateway(
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
      const stanMessage = setMockParcelObjectStore(activeParcelObject, activeParcelKey);

      const [activeParcel] = await pipe(
        STORE.liveStreamActiveParcelsForGateway(
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
      setMockParcelObjectStore(activeParcelObject, activeParcelKey);

      const [activeParcel] = await pipe(
        STORE.liveStreamActiveParcelsForGateway(
          peerGatewayAddress,
          MOCK_NATS_CLIENT,
          abortController.signal,
          mockLogging.logger,
        ),
        iterableTake(1),
        asyncIterableToArray,
      );

      await activeParcel.ack();

      expect(MOCK_OBJECT_STORE_CLIENT.deleteObject).toBeCalledWith(activeParcelKey, BUCKET);
    });
  });

  function setMockParcelObjectStore(storeObject: StoreObject, objectKey: string): Message {
    const stanMessage = mockStanMessage(Buffer.from(objectKey));
    getMockInstance(MOCK_NATS_CLIENT.makeQueueConsumer).mockReturnValue(
      arrayToAsyncIterable([stanMessage]),
    );
    getMockInstance(MOCK_OBJECT_STORE_CLIENT.getObject).mockImplementation((key) => {
      expect(key).toEqual(objectKey);
      return storeObject;
    });
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
    const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET);
    const parcelRetrieverSpy = jest
      .spyOn(store, 'retrieveActiveParcelsForGateway')
      .mockReturnValue(arrayToAsyncIterable([parcelObject]));

    const activeParcels = store.streamActiveParcelsForGateway(
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
      const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET);
      jest
        .spyOn(store, 'retrieveActiveParcelsForGateway')
        .mockReturnValue(arrayToAsyncIterable([parcelObject]));

      const [message] = await asyncIterableToArray(
        store.streamActiveParcelsForGateway(peerGatewayAddress, mockLogging.logger),
      );

      expect(MOCK_OBJECT_STORE_CLIENT.deleteObject).not.toBeCalled();
      await message.ack();
      expect(MOCK_OBJECT_STORE_CLIENT.deleteObject).toBeCalledWith(parcelObject.key, BUCKET);
    });
  });
});

describe('retrieveActiveParcelsForGateway', () => {
  const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET);

  test('Parcels should be limited to those for the specified gateway', async () => {
    await asyncIterableToArray(
      store.retrieveActiveParcelsForGateway(peerGatewayAddress, mockLogging.logger),
    );
    expect(MOCK_OBJECT_STORE_CLIENT.listObjectKeys).toBeCalledTimes(1);
    expect(MOCK_OBJECT_STORE_CLIENT.listObjectKeys).toBeCalledWith(
      `parcels/gateway-bound/${peerGatewayAddress}/`,
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
      store.retrieveActiveParcelsForGateway(peerGatewayAddress, mockLogging.logger),
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
      store.retrieveActiveParcelsForGateway(peerGatewayAddress, mockLogging.logger),
    );

    expect(activeParcels).toEqual([
      { key: parcel1Key, expiryDate: parcel1ExpiryDate, body: parcelSerialized, extra: null },
      { key: parcel2Key, expiryDate: parcel2ExpiryDate, body: parcel2Body, extra: null },
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
        store.retrieveActiveParcelsForGateway(peerGatewayAddress, mockLogging.logger),
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

describe('storeParcelFromPeerGateway', () => {
  const dummyObjectKey = 'the object key';

  test('Parcel should be bound for private gateway if recipient is private', async () => {
    const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET);
    const spiedStoreGatewayBoundParcel = jest
      .spyOn(store, 'storeGatewayBoundParcel')
      .mockImplementationOnce(async () => dummyObjectKey);

    // Make sure the shared fixture remains valid for this test:
    expect(parcel.isRecipientAddressPrivate).toBeTrue();

    await expect(
      store.storeParcelFromPeerGateway(
        parcel,
        parcelSerialized,
        await pdaChain.privateGatewayCert.calculateSubjectPrivateAddress(),
        MOCK_MONGOOSE_CONNECTION,
        MOCK_NATS_CLIENT,
      ),
    ).resolves.toEqual(dummyObjectKey);

    expect(spiedStoreGatewayBoundParcel).toBeCalledWith(
      parcel,
      parcelSerialized,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
    );
  });

  test('Parcel should be bound for public endpoint if recipient is public', async () => {
    const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET);
    const spiedStoreEndpointBoundParcel = jest
      .spyOn(store, 'storeEndpointBoundParcel')
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
      store.storeParcelFromPeerGateway(
        parcelForPublicEndpoint,
        parcelForPublicEndpointSerialized,
        await pdaChain.privateGatewayCert.calculateSubjectPrivateAddress(),
        MOCK_MONGOOSE_CONNECTION,
        MOCK_NATS_CLIENT,
      ),
    ).resolves.toEqual(dummyObjectKey);

    expect(spiedStoreEndpointBoundParcel).toBeCalledWith(
      parcelForPublicEndpoint,
      parcelForPublicEndpointSerialized,
      await pdaChain.privateGatewayCert.calculateSubjectPrivateAddress(),
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
    );
  });
});

describe('storeGatewayBoundParcel', () => {
  const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET);

  const mockRetrieveOwnCertificates = mockSpy(
    jest.spyOn(certs, 'retrieveOwnCertificates'),
    async () => [pdaChain.publicGatewayCert],
  );

  test('Parcel should be refused if sender is not trusted', async () => {
    const differentPDAChain = await generatePdaChain();
    mockRetrieveOwnCertificates.mockResolvedValue([differentPDAChain.publicGatewayCert]);

    await expect(
      store.storeGatewayBoundParcel(
        parcel,
        parcelSerialized,
        MOCK_MONGOOSE_CONNECTION,
        MOCK_NATS_CLIENT,
      ),
    ).rejects.toBeInstanceOf(InvalidMessageError);
    expect(MOCK_OBJECT_STORE_CLIENT.putObject).not.toBeCalled();
  });

  test('Parcel object key should be output', async () => {
    const key = await store.storeGatewayBoundParcel(
      parcel,
      parcelSerialized,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
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
    await store.storeGatewayBoundParcel(
      parcel,
      parcelSerialized,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
    );

    expect(MOCK_OBJECT_STORE_CLIENT.putObject).toBeCalledWith(
      expect.anything(),
      expect.anything(),
      BUCKET,
    );
  });

  test('Parcel expiry date should be stored as object metadata', async () => {
    await store.storeGatewayBoundParcel(
      parcel,
      parcelSerialized,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
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
    await store.storeGatewayBoundParcel(
      parcel,
      parcelSerialized,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
    );

    expect(MOCK_OBJECT_STORE_CLIENT.putObject).toBeCalledWith(
      expect.objectContaining({ body: parcelSerialized }),
      expect.anything(),
      expect.anything(),
    );
  });

  test('Parcel object key should be unique for the parcel, sender and recipient', async () => {
    const key = await store.storeGatewayBoundParcel(
      parcel,
      parcelSerialized,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
    );

    expect(MOCK_OBJECT_STORE_CLIENT.putObject).toBeCalledWith(
      expect.anything(),
      key,
      expect.anything(),
    );
  });

  test('Parcel object key should be published to right NATS Streaming channel', async () => {
    const key = await store.storeGatewayBoundParcel(
      parcel,
      parcelSerialized,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
    );

    expect(MOCK_NATS_CLIENT.publishMessage).toBeCalledTimes(1);
    expect(MOCK_NATS_CLIENT.publishMessage).toBeCalledWith(
      key,
      `pdc-parcel.${await pdaChain.privateGatewayCert.calculateSubjectPrivateAddress()}`,
    );
  });
});

describe('deleteGatewayBoundParcel', () => {
  const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET);

  test('Object should be deleted from the right bucket', async () => {
    await store.deleteGatewayBoundParcel('', '', '', '');

    expect(MOCK_OBJECT_STORE_CLIENT.deleteObject).toBeCalledWith(expect.anything(), BUCKET);
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

    expect(MOCK_OBJECT_STORE_CLIENT.deleteObject).toBeCalledWith(
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
  const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET);

  beforeEach(() => {
    getMockInstance(MOCK_OBJECT_STORE_CLIENT.getObject).mockResolvedValue({
      body: parcelSerialized,
    });
  });

  test('Object should be retrieved from the right bucket', async () => {
    await store.retrieveEndpointBoundParcel('');

    expect(MOCK_OBJECT_STORE_CLIENT.getObject).toBeCalledWith(expect.anything(), BUCKET);
  });

  test('Lookup object key should be prefixed', async () => {
    const key = 'thingy.parcel';
    await store.retrieveEndpointBoundParcel(key);

    expect(MOCK_OBJECT_STORE_CLIENT.getObject).toBeCalledWith(
      `parcels/endpoint-bound/${key}`,
      expect.anything(),
    );
  });

  test('Parcel should be returned', async () => {
    const retrievedParcelSerialized = await store.retrieveEndpointBoundParcel('key');

    expect(retrievedParcelSerialized).toEqual(parcelSerialized);
  });
});

describe('storeEndpointBoundParcel', () => {
  const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET);

  const mockWasParcelCollected = mockSpy(
    jest.spyOn(parcelCollection, 'wasParcelCollected'),
    () => false,
  );
  const mockRecordParcelCollection = mockSpy(
    jest.spyOn(parcelCollection, 'recordParcelCollection'),
    () => undefined,
  );

  test('Parcel should be refused if it is invalid', async () => {
    const invalidParcelCreationDate = new Date(pdaChain.pdaCert.startDate.getTime());
    invalidParcelCreationDate.setSeconds(invalidParcelCreationDate.getSeconds() - 1);
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
      ),
    ).rejects.toBeInstanceOf(InvalidMessageError);
    expect(MOCK_OBJECT_STORE_CLIENT.putObject).not.toBeCalled();
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
      ),
    ).resolves.toBeNull();

    expect(MOCK_OBJECT_STORE_CLIENT.putObject).not.toBeCalled();
    expect(mockWasParcelCollected).toBeCalledWith(
      parcel,
      peerGatewayAddress,
      MOCK_MONGOOSE_CONNECTION,
    );
  });

  test('The processing of the parcel should be recorded if successful', async () => {
    await store.storeEndpointBoundParcel(
      parcel,
      parcelSerialized,
      peerGatewayAddress,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
    );

    expect(mockRecordParcelCollection).toBeCalledWith(
      parcel,
      peerGatewayAddress,
      MOCK_MONGOOSE_CONNECTION,
    );
  });

  test('Generated object key should be output', async () => {
    const key = await store.storeEndpointBoundParcel(
      parcel,
      parcelSerialized,
      peerGatewayAddress,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
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
    );

    expect(MOCK_OBJECT_STORE_CLIENT.putObject).toBeCalledWith(
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
    );

    expect(MOCK_OBJECT_STORE_CLIENT.putObject).toBeCalledWith(
      expect.anything(),
      `parcels/endpoint-bound/${key}`,
      expect.anything(),
    );
  });

  test('Parcel serialization should be stored', async () => {
    await store.storeEndpointBoundParcel(
      parcel,
      parcelSerialized,
      peerGatewayAddress,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
    );

    expect(MOCK_OBJECT_STORE_CLIENT.putObject).toBeCalledWith(
      expect.objectContaining({ body: parcelSerialized }),
      expect.anything(),
      expect.anything(),
    );
  });

  test('Parcel data should be published to right NATS Streaming channel', async () => {
    const key = await store.storeEndpointBoundParcel(
      parcel,
      parcelSerialized,
      peerGatewayAddress,
      MOCK_MONGOOSE_CONNECTION,
      MOCK_NATS_CLIENT,
    );

    const expectedMessageData: QueuedInternetBoundParcelMessage = {
      parcelExpiryDate: parcel.expiryDate,
      parcelObjectKey: key!!,
      parcelRecipientAddress: parcel.recipientAddress,
    };
    expect(MOCK_NATS_CLIENT.publishMessage).toBeCalledWith(
      JSON.stringify(expectedMessageData),
      'internet-parcels',
    );
  });
});

describe('deleteEndpointBoundParcel', () => {
  const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET);

  test('Object should be deleted from the right bucket', async () => {
    await store.deleteEndpointBoundParcel('');

    expect(MOCK_OBJECT_STORE_CLIENT.deleteObject).toBeCalledWith(expect.anything(), BUCKET);
  });

  test('Full object key should be prefixed', async () => {
    const key = 'thingy.parcel';
    await store.deleteEndpointBoundParcel(key);

    expect(MOCK_OBJECT_STORE_CLIENT.deleteObject).toBeCalledWith(
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

  jest.spyOn(ObjectStoreClient, 'initFromEnv').mockReturnValue(MOCK_OBJECT_STORE_CLIENT);

  test('OBJECT_STORE_BUCKET should be required', () => {
    mockEnvVars({ ...requiredEnvVars, OBJECT_STORE_BUCKET: undefined });

    expect(() => ParcelStore.initFromEnv()).toThrowWithMessage(EnvVarError, /OBJECT_STORE_BUCKET/);
  });

  test('Parcel store should be returned', () => {
    const store = ParcelStore.initFromEnv();

    expect(store.bucket).toEqual(requiredEnvVars.OBJECT_STORE_BUCKET);
    expect(store.objectStoreClient).toBe(MOCK_OBJECT_STORE_CLIENT);
  });
});

describe('makeActiveParcelRetriever', () => {
  const store = new ParcelStore(MOCK_OBJECT_STORE_CLIENT, BUCKET);

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
    const error = new Error('That was deleted');
    getMockInstance(MOCK_OBJECT_STORE_CLIENT.getObject).mockRejectedValue(error);

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
          err: expect.objectContaining({ message: error.message }),
          parcelObjectKey: parcelObjectMetadata.key,
        },
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
