import { Certificate } from '@relaycorp/relaynet-core';
import { getModelForClass } from '@typegoose/typegoose';
import bufferToArray from 'buffer-to-arraybuffer';
import { Connection } from 'mongoose';

import { OwnCertificate } from './models';

export async function retrieveOwnCertificates(
  connection: Connection,
): Promise<readonly Certificate[]> {
  const ownCertificateModel = getModelForClass(OwnCertificate, { existingConnection: connection });
  const ownCerts = await ownCertificateModel.find({});
  return ownCerts.map((c) => Certificate.deserialize(bufferToArray(c.serializationDer)));
}
