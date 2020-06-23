import { Certificate } from '@relaycorp/relaynet-core';
import { getModelForClass } from '@typegoose/typegoose';
import bufferToArray from 'buffer-to-arraybuffer';
import { Connection } from 'mongoose';

import { OwnCertificate } from './models';

export async function retrieveOwnCertificates(
  connection: Connection,
): Promise<readonly Certificate[]> {
  const ownCertificateModel = getModelForClass(OwnCertificate, { existingConnection: connection });
  const findOne = ownCertificateModel.find({});
  const ownCerts = (await findOne.exec()) as readonly OwnCertificate[];

  return ownCerts.map((c) => Certificate.deserialize(bufferToArray(c.serializationDer)));
}
