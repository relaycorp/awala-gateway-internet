import {
  Certificate,
  Parcel,
  ParcelCollectionHandshakeSigner,
  StreamingMode,
} from '@relaycorp/relaynet-core';
import { PoWebClient } from '@relaycorp/relaynet-poweb';
import { pipeline } from 'streaming-iterables';

import { asyncIterableToArray, iterableTake } from '../../testUtils/iter';

/**
 * Wait for a parcel to become available for collection but don't actually collect it.
 */
export async function waitForNextParcel(
  client: PoWebClient,
  privateGatewayCert: Certificate,
  privateGatewayPrivateKey: CryptoKey,
): Promise<void> {
  const signer = new ParcelCollectionHandshakeSigner(privateGatewayCert, privateGatewayPrivateKey);
  await pipeline(
    () => client.collectParcels([signer], StreamingMode.KEEP_ALIVE),
    iterableTake(1),
    asyncIterableToArray,
  );
}

/**
 * Collect the next parcel available.
 */
export async function collectNextParcel(
  client: PoWebClient,
  privateGatewayCert: Certificate,
  privateGatewayPrivateKey: CryptoKey,
  streamingMode: StreamingMode = StreamingMode.KEEP_ALIVE,
): Promise<Parcel> {
  const signer = new ParcelCollectionHandshakeSigner(privateGatewayCert, privateGatewayPrivateKey);
  const incomingParcels = await pipeline(
    () => client.collectParcels([signer], streamingMode),
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
