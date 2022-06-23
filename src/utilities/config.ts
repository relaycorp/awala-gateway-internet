import typegoose from '@typegoose/typegoose';
import mongoose from 'mongoose';

import { ConfigItem } from '../models';

const { getModelForClass } = typegoose;

export enum ConfigKey {
  CURRENT_PRIVATE_ADDRESS = 'current_private_address',
}

export class Config {
  private readonly configItemModel: typegoose.ReturnModelType<typeof ConfigItem>;

  constructor(connection: mongoose.Connection) {
    this.configItemModel = getModelForClass(ConfigItem, { existingConnection: connection });
  }

  public async set(key: ConfigKey, value: string): Promise<void> {
    const record: ConfigItem = { key, value };
    await this.configItemModel.updateOne({ key }, record, { upsert: true });
  }

  public async get(key: ConfigKey): Promise<string | null> {
    const record = await this.configItemModel.findOne({ key }).exec();
    return record?.value ?? null;
  }
}
