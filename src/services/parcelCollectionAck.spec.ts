import { ParcelCollectionAck } from '@relaycorp/relaynet-core';
import * as typegoose from '@typegoose/typegoose';
import { Connection } from 'mongoose';

import { arrayToAsyncIterable, asyncIterableToArray, mockSpy } from '../_test_utils';
import { ParcelCollection } from './models';
import { generatePCAs } from './parcelCollectionAck';

const PEER_GATEWAY_PRIVATE_ADDRESS = '0deadbeef';

const MOCK_CONNECTION: Connection = { what: 'the-stub-connection' } as any;
const MOCK_GET_MODEL_FOR_CLASS = mockSpy(jest.spyOn(typegoose, 'getModelForClass'));

describe('generatePCAs', () => {
  const PARCEL_COLLECTION: ParcelCollection = {
    parcelExpiryDate: new Date(2014, 2),
    parcelId: 'the-id',
    peerGatewayPrivateAddress: PEER_GATEWAY_PRIVATE_ADDRESS,
    recipientEndpointAddress: 'http://example.com',
    senderEndpointPrivateAddress: '0beef',
  };

  const MOCK_MONGOOSE_FIND = mockSpy(jest.fn(), async function*(): AsyncIterable<ParcelCollection> {
    yield* arrayToAsyncIterable([]);
  });
  beforeEach(() => MOCK_GET_MODEL_FOR_CLASS.mockReturnValue({ find: MOCK_MONGOOSE_FIND }));

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
