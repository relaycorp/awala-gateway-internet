import { PublicKeyStore, SessionPublicKeyData } from '@relaycorp/relaynet-core';
import { getModelForClass } from '@typegoose/typegoose';
import { Connection, Model } from 'mongoose';

import { PeerPublicKeyData } from '../models';

export class MongoPublicKeyStore extends PublicKeyStore {
  protected readonly keyDataModel: Model<any>;

  constructor(connection: Connection) {
    super();

    this.keyDataModel = getModelForClass(PeerPublicKeyData, {
      existingConnection: connection,
    });
  }

  protected retrieveIdentityKeySerialized(_peerId: string): Promise<Buffer | null> {
    throw new Error('Method not yet implemented');
  }

  protected saveIdentityKeySerialized(_keySerialized: Buffer, _peerId: string): Promise<void> {
    throw new Error('Method not yet implemented');
  }

  protected async retrieveSessionKeyData(peerId: string): Promise<SessionPublicKeyData | null> {
    const query = this.keyDataModel.findOne({ peerId });
    const keyData: null | PeerPublicKeyData = await query.exec();
    if (keyData === null) {
      return null;
    }
    return {
      publicKeyCreationTime: keyData.creationDate,
      publicKeyDer: keyData.keyDer,
      publicKeyId: keyData.keyId,
    };
  }

  protected async saveSessionKeyData(keyData: SessionPublicKeyData, peerId: string): Promise<void> {
    const dbData: PeerPublicKeyData = {
      creationDate: keyData.publicKeyCreationTime,
      keyDer: keyData.publicKeyDer,
      keyId: keyData.publicKeyId,
      peerId,
    };
    await this.keyDataModel.updateOne({ peerId }, dbData, { upsert: true }).exec();
  }
}
