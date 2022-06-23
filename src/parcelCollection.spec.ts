import { generateRSAKeyPair, Parcel, ParcelCollectionAck } from '@relaycorp/relaynet-core';
import * as typegoose from '@typegoose/typegoose';
import mongoose from 'mongoose';

import { ParcelCollection } from './models';
import { generatePCAs, recordParcelCollection, wasParcelCollected } from './parcelCollection';
import { arrayToAsyncIterable, asyncIterableToArray } from './testUtils/iter';
import { mockSpy } from './testUtils/jest';
import { generateStubEndpointCertificate } from './testUtils/pki';

const PEER_GATEWAY_PRIVATE_ADDRESS = '0deadbeef';

const MOCK_CONNECTION: mongoose.Connection = { what: 'the-stub-connection' } as any;
const MOCK_GET_MODEL_FOR_CLASS = mockSpy(jest.spyOn(typegoose, 'getModelForClass'));

let PARCEL: Parcel;
beforeAll(async () => {
  const senderKeyPair = await generateRSAKeyPair();
  const senderCertificate = await generateStubEndpointCertificate(senderKeyPair);
  PARCEL = new Parcel('https://example.com', senderCertificate, Buffer.from([]));
});

describe('wasParcelCollected', () => {
  const MOCK_MONGOOSE_EXISTS = mockSpy(jest.fn());
  beforeEach(() =>
    MOCK_GET_MODEL_FOR_CLASS.mockReturnValue({ exists: MOCK_MONGOOSE_EXISTS } as any),
  );

  test('Lookup should use parcel id, sender, recipient and peer GW address', async () => {
    await wasParcelCollected(PARCEL, PEER_GATEWAY_PRIVATE_ADDRESS, MOCK_CONNECTION);

    expect(MOCK_MONGOOSE_EXISTS).toBeCalledWith({
      parcelId: PARCEL.id,
      peerGatewayPrivateAddress: PEER_GATEWAY_PRIVATE_ADDRESS,
      recipientEndpointAddress: PARCEL.recipientAddress,
      senderEndpointPrivateAddress: await PARCEL.senderCertificate.calculateSubjectPrivateAddress(),
    });
  });

  test('True should be returned if it was already collected', async () => {
    MOCK_MONGOOSE_EXISTS.mockReturnValue(true);

    await expect(
      wasParcelCollected(PARCEL, PEER_GATEWAY_PRIVATE_ADDRESS, MOCK_CONNECTION),
    ).resolves.toBeTrue();
  });

  test('False should be returned if it has not been collected', async () => {
    MOCK_MONGOOSE_EXISTS.mockReturnValue(false);

    await expect(
      wasParcelCollected(PARCEL, PEER_GATEWAY_PRIVATE_ADDRESS, MOCK_CONNECTION),
    ).resolves.toBeFalse();
  });
});

describe('recordParcelCollection', () => {
  const MOCK_MONGOOSE_REPLACE_ONE_EXEC = mockSpy(jest.fn());
  const MOCK_MONGOOSE_REPLACE_ONE_SET_OPTIONS = mockSpy(jest.fn(), () => ({
    exec: MOCK_MONGOOSE_REPLACE_ONE_EXEC,
  }));
  const MOCK_MONGOOSE_REPLACE_ONE = mockSpy(jest.fn(), () => ({
    setOptions: MOCK_MONGOOSE_REPLACE_ONE_SET_OPTIONS,
  }));
  beforeEach(() =>
    MOCK_GET_MODEL_FOR_CLASS.mockReturnValue({ replaceOne: MOCK_MONGOOSE_REPLACE_ONE } as any),
  );

  test('Parcel metadata should be upserted', async () => {
    await recordParcelCollection(PARCEL, PEER_GATEWAY_PRIVATE_ADDRESS, MOCK_CONNECTION);

    const collection = {
      parcelId: PARCEL.id,
      peerGatewayPrivateAddress: PEER_GATEWAY_PRIVATE_ADDRESS,
      recipientEndpointAddress: PARCEL.recipientAddress,
      senderEndpointPrivateAddress: await PARCEL.senderCertificate.calculateSubjectPrivateAddress(),
    };
    expect(MOCK_MONGOOSE_REPLACE_ONE).toBeCalledWith(collection, {
      ...collection,
      parcelExpiryDate: PARCEL.expiryDate,
    });
    expect(MOCK_MONGOOSE_REPLACE_ONE_SET_OPTIONS).toBeCalledWith({ upsert: true });
    expect(MOCK_MONGOOSE_REPLACE_ONE_EXEC).toBeCalled();
  });
});

describe('generatePCAs', () => {
  let PARCEL_COLLECTION: ParcelCollection;
  beforeAll(async () => {
    PARCEL_COLLECTION = {
      parcelExpiryDate: PARCEL.expiryDate,
      parcelId: PARCEL.id,
      peerGatewayPrivateAddress: PEER_GATEWAY_PRIVATE_ADDRESS,
      recipientEndpointAddress: PARCEL.recipientAddress,
      senderEndpointPrivateAddress: await PARCEL.senderCertificate.calculateSubjectPrivateAddress(),
    };
  });

  const MOCK_MONGOOSE_FIND = mockSpy(
    jest.fn(),
    async function* (): AsyncIterable<ParcelCollection> {
      yield* arrayToAsyncIterable([]);
    },
  );
  beforeEach(() => MOCK_GET_MODEL_FOR_CLASS.mockReturnValue({ find: MOCK_MONGOOSE_FIND } as any));

  test('Existing connection should be used', async () => {
    await asyncIterableToArray(generatePCAs(PEER_GATEWAY_PRIVATE_ADDRESS, MOCK_CONNECTION));

    expect(MOCK_GET_MODEL_FOR_CLASS).toBeCalledTimes(1);
    expect(MOCK_GET_MODEL_FOR_CLASS).toBeCalledWith(ParcelCollection, {
      existingConnection: MOCK_CONNECTION,
    });
  });

  test('PCAs should be limited to specified peer gateway', async () => {
    await asyncIterableToArray(generatePCAs(PEER_GATEWAY_PRIVATE_ADDRESS, MOCK_CONNECTION));

    expect(MOCK_MONGOOSE_FIND).toBeCalledTimes(1);
    expect(MOCK_MONGOOSE_FIND).toBeCalledWith({
      peerGatewayPrivateAddress: PEER_GATEWAY_PRIVATE_ADDRESS,
    });
  });

  test('No PCAs should be output if there is none to return', async () => {
    const results = await asyncIterableToArray(
      generatePCAs(PEER_GATEWAY_PRIVATE_ADDRESS, MOCK_CONNECTION),
    );

    expect(results).toHaveLength(0);
  });

  test('Results should include PCA serialized', async () => {
    MOCK_MONGOOSE_FIND.mockReturnValue(arrayToAsyncIterable([PARCEL_COLLECTION]));

    const results = await asyncIterableToArray(
      generatePCAs(PEER_GATEWAY_PRIVATE_ADDRESS, MOCK_CONNECTION),
    );

    const expectedPca = new ParcelCollectionAck(
      PARCEL_COLLECTION.senderEndpointPrivateAddress,
      PARCEL_COLLECTION.recipientEndpointAddress,
      PARCEL_COLLECTION.parcelId,
    );
    expect(results).toHaveLength(1);
    expect(results[0].message).toEqual(Buffer.from(expectedPca.serialize()));
  });

  test('Results should include expiry date of corresponding parcel', async () => {
    MOCK_MONGOOSE_FIND.mockReturnValue(arrayToAsyncIterable([PARCEL_COLLECTION]));

    const results = await asyncIterableToArray(
      generatePCAs(PEER_GATEWAY_PRIVATE_ADDRESS, MOCK_CONNECTION),
    );

    expect(results).toHaveLength(1);
    expect(results[0].expiryDate).toEqual(PARCEL_COLLECTION.parcelExpiryDate);
  });
});
