import { CargoMessageStream, Parcel, ParcelCollectionAck } from '@relaycorp/relaynet-core';
import { getModelForClass } from '@typegoose/typegoose';
import { Connection } from 'mongoose';

import { ParcelCollection } from './models';

export async function wasParcelCollected(
  parcel: Parcel,
  peerGatewayPrivateAddress: string,
  connection: Connection,
): Promise<boolean> {
  const collectionModel = getModelForClass(ParcelCollection, { existingConnection: connection });
  const collection = await collectionModel.exists({
    parcelId: parcel.id,
    peerGatewayPrivateAddress,
    recipientEndpointAddress: parcel.recipientAddress,
    senderEndpointPrivateAddress: await parcel.senderCertificate.calculateSubjectPrivateAddress(),
  });
  return !!collection;
}

export async function recordParcelCollection(
  parcel: Parcel,
  peerGatewayPrivateAddress: string,
  connection: Connection,
): Promise<void> {
  const collectionModel = getModelForClass(ParcelCollection, { existingConnection: connection });
  const baseFields: Partial<ParcelCollection> = {
    parcelId: parcel.id,
    peerGatewayPrivateAddress,
    recipientEndpointAddress: parcel.recipientAddress,
    senderEndpointPrivateAddress: await parcel.senderCertificate.calculateSubjectPrivateAddress(),
  };
  await collectionModel
    .replaceOne(baseFields, { ...baseFields, parcelExpiryDate: parcel.expiryDate })
    .setOptions({ upsert: true })
    .exec();
}

export async function* generatePCAs(
  peerGatewayPrivateAddress: string,
  connection: Connection,
): CargoMessageStream {
  const collectionModel = getModelForClass(ParcelCollection, { existingConnection: connection });

  for await (const collection of collectionModel.find({ peerGatewayPrivateAddress }) as any) {
    const pca = new ParcelCollectionAck(
      collection.senderEndpointPrivateAddress,
      collection.recipientEndpointAddress,
      collection.parcelId,
    );
    yield { expiryDate: collection.parcelExpiryDate, message: Buffer.from(pca.serialize()) };
  }
}
