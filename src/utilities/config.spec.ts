import { getModelForClass, ReturnModelType } from '@typegoose/typegoose';

import { ConfigItem } from '../models';
import { setUpTestDBConnection } from '../testUtils/db';
import { Config, ConfigKey } from './config';

const getConnection = setUpTestDBConnection();
let configItemModel: ReturnModelType<typeof ConfigItem>;
beforeAll(async () => {
  configItemModel = getModelForClass(ConfigItem, { existingConnection: getConnection() });
});

const PRIVATE_ADDRESS = '0deafbeef';

describe('Config', () => {
  describe('set', () => {
    test('Item should be created if it does not already exist', async () => {
      const config = new Config(getConnection());

      await config.set(ConfigKey.CURRENT_ID, PRIVATE_ADDRESS);

      await expect(
        configItemModel.countDocuments({
          key: ConfigKey.CURRENT_ID,
          value: PRIVATE_ADDRESS,
        }),
      ).resolves.toEqual(1);
    });

    test('Item should be updated if it already exists', async () => {
      const config = new Config(getConnection());
      await config.set(ConfigKey.CURRENT_ID, PRIVATE_ADDRESS);
      const newValue = `new ${PRIVATE_ADDRESS}`;
      await config.set(ConfigKey.CURRENT_ID, newValue);

      await expect(
        configItemModel.countDocuments({ key: ConfigKey.CURRENT_ID, value: newValue }),
      ).resolves.toEqual(1);
    });
  });

  describe('get', () => {
    test('Null should be returned for non-existing item', async () => {
      const config = new Config(getConnection());

      await expect(config.get(ConfigKey.CURRENT_ID)).resolves.toBeNull();
    });

    test('Value should be returned if item exists', async () => {
      const config = new Config(getConnection());
      await config.set(ConfigKey.CURRENT_ID, PRIVATE_ADDRESS);

      await expect(config.get(ConfigKey.CURRENT_ID)).resolves.toEqual(PRIVATE_ADDRESS);
    });
  });
});
