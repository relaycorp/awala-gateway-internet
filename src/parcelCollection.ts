import { CargoMessageStream, Parcel, ParcelCollectionAck } from '@relaycorp/relaynet-core';
import { getModelForClass } from '@typegoose/typegoose';
import { Connection } from 'mongoose';

import { ParcelCollection } from './models';

export async function wasParcelCollected(
  parcel: Parcel,
  privatePeerId: string,
  connection: Connection,
): Promise<boolean> {
  const collectionModel = getModelForClass(ParcelCollection, { existingConnection: connection });
  const collection = await collectionModel.exists({
    parcelId: parcel.id,
    privatePeerId,
    recipientEndpointId: parcel.recipient.id,
    senderEndpointId: await parcel.senderCertificate.calculateSubjectId(),
  });
  return !!collection;
}

export async function recordParcelCollection(
  parcel: Parcel,
  privatePeerId: string,
  connection: Connection,
): Promise<void> {
  const collectionModel = getModelForClass(ParcelCollection, { existingConnection: connection });
  const baseFields: Partial<ParcelCollection> = {
    parcelId: parcel.id,
    privatePeerId,
    recipientEndpointId: parcel.recipient.id,
    senderEndpointId: await parcel.senderCertificate.calculateSubjectId(),
  };
  await collectionModel
    .replaceOne(baseFields, { ...baseFields, parcelExpiryDate: parcel.expiryDate })
    .setOptions({ upsert: true })
    .exec();
}

export async function* generatePCAs(
  privatePeerId: string,
  connection: Connection,
): CargoMessageStream {
  const collectionModel = getModelForClass(ParcelCollection, { existingConnection: connection });

  for await (const collection of collectionModel.find({ privatePeerId }) as any) {
    const pca = new ParcelCollectionAck(
      collection.senderEndpointId,
      collection.recipientEndpointId,
      collection.parcelId,
    );
    yield { expiryDate: collection.parcelExpiryDate, message: Buffer.from(pca.serialize()) };
  }
}
