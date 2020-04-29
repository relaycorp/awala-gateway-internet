import { CargoMessageStream, ParcelCollectionAck } from '@relaycorp/relaynet-core';
import { getModelForClass } from '@typegoose/typegoose';
import { Connection } from 'mongoose';

import { ParcelCollection } from './models';

export async function* generatePCAs(
  peerGatewayPrivateAddress: string,
  connection: Connection,
): CargoMessageStream {
  const collectionModel = getModelForClass(ParcelCollection, { existingConnection: connection });

  // @ts-ignore
  for await (const collection of collectionModel.find({ peerGatewayPrivateAddress })) {
    const pca = new ParcelCollectionAck(
      collection.senderEndpointPrivateAddress,
      collection.recipientEndpointAddress,
      collection.parcelId,
    );
    yield { expiryDate: collection.parcelExpiryDate, message: Buffer.from(pca.serialize()) };
  }
}
