import { PublicKeyStore, SessionPublicKeyData } from '@relaycorp/relaynet-core';
import typegoose from '@typegoose/typegoose';
import mongoose from 'mongoose';

import { PeerPublicKeyData } from '../models';

const { getModelForClass } = typegoose;

export class MongoPublicKeyStore extends PublicKeyStore {
  protected readonly keyDataModel: mongoose.Model<any>;

  constructor(connection: mongoose.Connection) {
    super();

    this.keyDataModel = getModelForClass(PeerPublicKeyData, {
      existingConnection: connection,
    });
  }

  protected retrieveIdentityKeySerialized(_peerPrivateAddress: string): Promise<Buffer | null> {
    throw new Error('Method not yet implemented');
  }

  protected saveIdentityKeySerialized(
    _keySerialized: Buffer,
    _peerPrivateAddress: string,
  ): Promise<void> {
    throw new Error('Method not yet implemented');
  }

  protected async retrieveSessionKeyData(
    peerPrivateAddress: string,
  ): Promise<SessionPublicKeyData | null> {
    const query = this.keyDataModel.findOne({ peerPrivateAddress });
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

  protected async saveSessionKeyData(
    keyData: SessionPublicKeyData,
    peerPrivateAddress: string,
  ): Promise<void> {
    const dbData: PeerPublicKeyData = {
      creationDate: keyData.publicKeyCreationTime,
      keyDer: keyData.publicKeyDer,
      keyId: keyData.publicKeyId,
      peerPrivateAddress,
    };
    await this.keyDataModel.updateOne({ peerPrivateAddress }, dbData, { upsert: true }).exec();
  }
}
