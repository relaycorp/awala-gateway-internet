import { CertificateStore } from '@relaycorp/relaynet-core';
import { getModelForClass, ReturnModelType } from '@typegoose/typegoose';
import bufferToArray from 'buffer-to-arraybuffer';
import { Connection } from 'mongoose';

import { CertificationPath } from '../models';

export class MongoCertificateStore extends CertificateStore {
  private readonly certificateModel: ReturnModelType<typeof CertificationPath>;

  constructor(connection: Connection) {
    super();

    this.certificateModel = getModelForClass(CertificationPath, { existingConnection: connection });
  }

  public async deleteExpired(): Promise<void> {
    // Do nothing. Trust that the model will delete expired records.
  }

  protected async saveData(
    subjectCertificateSerialized: ArrayBuffer,
    subjectPrivateAddress: string,
    subjectCertificateExpiryDate: Date,
    issuerPrivateAddress: string,
  ): Promise<void> {
    const record: CertificationPath = {
      expiryDate: subjectCertificateExpiryDate,
      issuerPrivateAddress,
      pathSerialized: Buffer.from(subjectCertificateSerialized),
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
    return record ? bufferToArray(record.pathSerialized) : null;
  }

  protected async retrieveAllSerializations(
    subjectPrivateAddress: string,
  ): Promise<readonly ArrayBuffer[]> {
    const records = await this.certificateModel.find({ subjectPrivateAddress }).exec();
    return records.map((r) => bufferToArray(r.pathSerialized));
  }
}
