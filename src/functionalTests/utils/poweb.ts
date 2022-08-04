import {
  Certificate,
  Parcel,
  ParcelCollectionHandshakeSigner,
  StreamingMode,
} from '@relaycorp/relaynet-core';
import { PoWebClient } from '@relaycorp/relaynet-poweb';
import { pipeline } from 'streaming-iterables';

import { asyncIterableToArray, iterableTake } from '../../testUtils/iter';

export async function collectNextParcel(
  powebClient: PoWebClient,
  privateGatewayCert: Certificate,
  privateGatewayPrivateKey: CryptoKey,
  streamingMode: StreamingMode = StreamingMode.KEEP_ALIVE,
): Promise<Parcel> {
  const signer = new ParcelCollectionHandshakeSigner(privateGatewayCert, privateGatewayPrivateKey);
  const incomingParcels = await pipeline(
    () => powebClient.collectParcels([signer], streamingMode),
    async function* (collections): AsyncIterable<Parcel> {
      for await (const collection of collections) {
        yield await collection.deserializeAndValidateParcel();
        await collection.ack();
      }
    },
    iterableTake(1),
    asyncIterableToArray,
  );
  expect(incomingParcels).toHaveLength(1);
  return incomingParcels[0];
}
