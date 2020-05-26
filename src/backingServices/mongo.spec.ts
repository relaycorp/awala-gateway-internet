import { EnvVarError } from 'env-var';
import mongoose from 'mongoose';

import { mockSpy } from '../_test_utils';
import { configureMockEnvVars } from '../services/_test_utils';
import { createMongooseConnectionFromEnv } from './mongo';

const MOCK_MONGOOSE_CONNECTION = { what: 'The connection' };
const MOCK_MONGOOSE_CREATE_CONNECTION = mockSpy(
  jest.spyOn(mongoose, 'createConnection'),
  jest.fn().mockResolvedValue(MOCK_MONGOOSE_CONNECTION),
);

const MONGO_URI = 'mongodb://example.com';

const mockEnvVars = configureMockEnvVars({ MONGO_URI });

describe('createMongooseConnectionFromEnv', () => {
  test('Environment variable MONGO_URI should be present', async () => {
    mockEnvVars({ MONGO_URI: undefined });

    await expect(createMongooseConnectionFromEnv()).rejects.toBeInstanceOf(EnvVarError);
  });

  test('Connection should use MONGO_URI', async () => {
    await createMongooseConnectionFromEnv();

    expect(MOCK_MONGOOSE_CREATE_CONNECTION).toBeCalledWith(
      MONGO_URI,
      expect.anything(),
    );
  });

  test('Mongoose connection should be returned', async () => {
    const connection = await createMongooseConnectionFromEnv();

    expect(connection).toBe(MOCK_MONGOOSE_CONNECTION)
  });

  test('Connection should be created with new URL parser', async () => {
    await createMongooseConnectionFromEnv();

    expect(MOCK_MONGOOSE_CREATE_CONNECTION).toBeCalledWith(
      expect.anything(),
      expect.objectContaining({ useNewUrlParser: true }),
    );
  });

  test('Connection should use unified topology', async () => {
    await createMongooseConnectionFromEnv();

    expect(MOCK_MONGOOSE_CREATE_CONNECTION).toBeCalledWith(
      expect.anything(),
      expect.objectContaining({ useUnifiedTopology: true }),
    );
  });
});
