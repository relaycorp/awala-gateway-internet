import {
  PublicKeyStore,
  PublicKeyStoreError,
  SessionPublicKeyData,
} from '@relaycorp/relaynet-core';
import { getModelForClass } from '@typegoose/typegoose';
import { Connection, Model } from 'mongoose';

import { PeerPublicKeyData } from './models';

export class MongoPublicKeyStore extends PublicKeyStore {
  protected readonly keyDataModel: Model<any>;

  constructor(connection: Connection) {
    super();

    this.keyDataModel = getModelForClass(PeerPublicKeyData, {
      existingConnection: connection,
    });
  }

  protected async fetchKey(peerPrivateAddress: string): Promise<SessionPublicKeyData> {
    const query = this.keyDataModel.findOne({ peerPrivateAddress });
    const keyData: null | PeerPublicKeyData = await query.exec();
    if (keyData === null) {
      throw new PublicKeyStoreError('Key could not be found');
    }
    return {
      publicKeyCreationTime: keyData.creationDate,
      publicKeyDer: keyData.keyDer,
      publicKeyId: keyData.keyId,
    };
  }

  protected async saveKey(
    keyData: SessionPublicKeyData,
    peerPrivateAddress: string,
  ): Promise<void> {
    const dbData: PeerPublicKeyData = {
      creationDate: keyData.publicKeyCreationTime,
      keyDer: keyData.publicKeyDer,
      keyId: keyData.publicKeyId,
      peerPrivateAddress,
    };
    await this.keyDataModel
      .findOneAndUpdate({ peerPrivateAddress }, dbData, { upsert: true })
      .exec();
  }
}
