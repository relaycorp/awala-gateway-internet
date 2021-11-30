import { CertificateStore } from '@relaycorp/relaynet-core';
import { getModelForClass, ReturnModelType } from '@typegoose/typegoose';
import bufferToArray from 'buffer-to-arraybuffer';
import { Connection } from 'mongoose';

import { Certificate } from '../models';

export class MongoCertificateStore extends CertificateStore {
  protected readonly certificateModel: ReturnModelType<typeof Certificate>;

  constructor(connection: Connection) {
    super();

    this.certificateModel = getModelForClass(Certificate, { existingConnection: connection });
  }

  public async deleteExpired(): Promise<void> {
    // Do nothing. Trust that the model will delete expired records.
  }

  protected async saveData(
    subjectPrivateAddress: string,
    subjectCertificateSerialized: ArrayBuffer,
    subjectCertificateExpiryDate: Date,
  ): Promise<void> {
    const record: Certificate = {
      certificateSerialized: Buffer.from(subjectCertificateSerialized),
      expiryDate: subjectCertificateExpiryDate,
      subjectPrivateAddress,
    };
    await this.certificateModel
      .updateOne(
        {
          expiryDate: subjectCertificateExpiryDate,
          subjectPrivateAddress,
        },
        record,
        { upsert: true },
      )
      .exec();
  }

  protected async retrieveLatestSerialization(
    subjectPrivateAddress: string,
  ): Promise<ArrayBuffer | null> {
    const record = await this.certificateModel
      .findOne({ subjectPrivateAddress })
      .sort({ expiryDate: -1 })
      .exec();
    return record ? bufferToArray(record.certificateSerialized) : null;
  }

  protected async retrieveAllSerializations(
    subjectPrivateAddress: string,
  ): Promise<readonly ArrayBuffer[]> {
    const records = await this.certificateModel.find({ subjectPrivateAddress }).exec();
    return records.map((r) => bufferToArray(r.certificateSerialized));
  }
}
