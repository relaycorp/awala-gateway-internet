import { getModelForClass, ReturnModelType } from '@typegoose/typegoose';

import { setUpTestDBConnection } from '../_test_utils';
import { ConfigItem } from '../models';
import { Config, ConfigKey } from './config';

const getConnection = setUpTestDBConnection();
let configItemModel: ReturnModelType<typeof ConfigItem>;
beforeAll(async () => {
  configItemModel = getModelForClass(ConfigItem, { existingConnection: getConnection() });
});

beforeEach(async () => {
  await configItemModel.deleteMany();
});

const PRIVATE_ADDRESS = '0deafbeef';

describe('Config', () => {
  describe('set', () => {
    test('Item should be created if it does not already exist', async () => {
      const config = new Config(getConnection());

      await config.set(ConfigKey.CURRENT_PRIVATE_ADDRESS, PRIVATE_ADDRESS);

      await expect(
        configItemModel.countDocuments({
          key: ConfigKey.CURRENT_PRIVATE_ADDRESS,
          value: PRIVATE_ADDRESS,
        }),
      ).resolves.toEqual(1);
    });

    test('Item should be updated if it already exists', async () => {
      const config = new Config(getConnection());
      await config.set(ConfigKey.CURRENT_PRIVATE_ADDRESS, PRIVATE_ADDRESS);
      const newValue = `new ${PRIVATE_ADDRESS}`;
      await config.set(ConfigKey.CURRENT_PRIVATE_ADDRESS, newValue);

      await expect(
        configItemModel.countDocuments({ key: ConfigKey.CURRENT_PRIVATE_ADDRESS, value: newValue }),
      ).resolves.toEqual(1);
    });
  });

  describe('get', () => {
    test('Null should be returned for non-existing item', async () => {
      const config = new Config(getConnection());

      await expect(config.get(ConfigKey.CURRENT_PRIVATE_ADDRESS)).resolves.toBeNull();
    });

    test('Value should be returned if item exists', async () => {
      const config = new Config(getConnection());
      await config.set(ConfigKey.CURRENT_PRIVATE_ADDRESS, PRIVATE_ADDRESS);

      await expect(config.get(ConfigKey.CURRENT_PRIVATE_ADDRESS)).resolves.toEqual(PRIVATE_ADDRESS);
    });
  });
});
