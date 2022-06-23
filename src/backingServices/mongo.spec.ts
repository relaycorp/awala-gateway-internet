import envVar from 'env-var';
import mongoose from 'mongoose';

import { configureMockEnvVars } from '../testUtils/envVars';
import { mockSpy } from '../testUtils/jest';
import { createMongooseConnectionFromEnv } from './mongo';

const MOCK_MONGOOSE_CONNECTION: mongoose.Connection = {
  model: { bind: mockSpy(jest.fn()) },
} as any;
const MOCK_MONGOOSE_CREATE_CONNECTION = mockSpy(
  jest.spyOn(mongoose, 'createConnection'),
  jest.fn().mockReturnValue({ asPromise: () => MOCK_MONGOOSE_CONNECTION }),
);

const MONGO_ENV_VARS = {
  MONGO_DB: 'the_db',
  MONGO_PASSWORD: 'letmein',
  MONGO_URI: 'mongodb://example.com',
  MONGO_USER: 'alicia',
};
const mockEnvVars = configureMockEnvVars(MONGO_ENV_VARS);

describe('createMongooseConnectionFromEnv', () => {
  test.each(Object.getOwnPropertyNames(MONGO_ENV_VARS))(
    'Environment variable %s should be present',
    async (envVarName) => {
      mockEnvVars({ ...MONGO_ENV_VARS, [envVarName]: undefined });

      await expect(createMongooseConnectionFromEnv()).rejects.toBeInstanceOf(envVar.EnvVarError);
    },
  );

  test('Connection should use MONGO_URI', async () => {
    await createMongooseConnectionFromEnv();

    expect(MOCK_MONGOOSE_CREATE_CONNECTION).toBeCalledWith(
      MONGO_ENV_VARS.MONGO_URI,
      expect.anything(),
    );
  });

  test('Connection should use MONGO_DB', async () => {
    await createMongooseConnectionFromEnv();

    expect(MOCK_MONGOOSE_CREATE_CONNECTION).toBeCalledWith(
      expect.anything(),
      expect.objectContaining({ dbName: MONGO_ENV_VARS.MONGO_DB }),
    );
  });

  test('Connection should use MONGO_USER', async () => {
    await createMongooseConnectionFromEnv();

    expect(MOCK_MONGOOSE_CREATE_CONNECTION).toBeCalledWith(
      expect.anything(),
      expect.objectContaining({ user: MONGO_ENV_VARS.MONGO_USER }),
    );
  });

  test('Connection should use MONGO_PASSWORD', async () => {
    await createMongooseConnectionFromEnv();

    expect(MOCK_MONGOOSE_CREATE_CONNECTION).toBeCalledWith(
      expect.anything(),
      expect.objectContaining({ pass: MONGO_ENV_VARS.MONGO_PASSWORD }),
    );
  });

  test('Mongoose connection should be returned', async () => {
    const connection = await createMongooseConnectionFromEnv();

    expect(connection).toBe(MOCK_MONGOOSE_CONNECTION);
  });
});
