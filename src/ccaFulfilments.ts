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
    peerPrivateAddress: await cca.senderCertificate.calculateSubjectPrivateAddress(),
  });
  return !!fulfillment;
}

export async function recordCCAFulfillment(
  cca: CargoCollectionAuthorization,
  connection: Connection,
): Promise<void> {
  const fulfillmentModel = getModelForClass(CCAFulfillment, { existingConnection: connection });

  const peerPrivateAddress = await cca.senderCertificate.calculateSubjectPrivateAddress();
  const fulfillment: CCAFulfillment = {
    ccaExpiryDate: cca.expiryDate,
    ccaId: cca.id,
    peerPrivateAddress,
  };
  await fulfillmentModel
    .replaceOne({ ccaId: cca.id, peerPrivateAddress }, fulfillment)
    .setOptions({ upsert: true })
    .exec();
}
