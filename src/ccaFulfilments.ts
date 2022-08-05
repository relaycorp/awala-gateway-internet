import { CargoCollectionAuthorization } from '@relaycorp/relaynet-core';
import { getModelForClass } from '@typegoose/typegoose';
import { Connection } from 'mongoose';

import { CCAFulfillment } from './models';

export async function wasCCAFulfilled(
  cca: CargoCollectionAuthorization,
  connection: Connection,
): Promise<boolean> {
  const fulfillmentModel = getModelForClass(CCAFulfillment, { existingConnection: connection });
  const fulfillment = await fulfillmentModel.exists({
    ccaId: cca.id,
    peerId: await cca.senderCertificate.calculateSubjectId(),
  });
  return !!fulfillment;
}

export async function recordCCAFulfillment(
  cca: CargoCollectionAuthorization,
  connection: Connection,
): Promise<void> {
  const fulfillmentModel = getModelForClass(CCAFulfillment, { existingConnection: connection });

  const peerId = await cca.senderCertificate.calculateSubjectId();
  const fulfillment: CCAFulfillment = {
    ccaExpiryDate: cca.expiryDate,
    ccaId: cca.id,
    peerId,
  };
  await fulfillmentModel
    .replaceOne({ ccaId: cca.id, peerId }, fulfillment)
    .setOptions({ upsert: true })
    .exec();
}
