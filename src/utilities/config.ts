import { getModelForClass, ReturnModelType } from '@typegoose/typegoose';

import { Connection } from 'mongoose';
import { ConfigItem } from '../models';

export enum ConfigKey {
  CURRENT_ID = 'current_id',
}

export class Config {
  private readonly configItemModel: ReturnModelType<typeof ConfigItem>;

  constructor(connection: Connection) {
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
