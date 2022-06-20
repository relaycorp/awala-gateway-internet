import { EnvVarError } from 'env-var';
import mongoose, { Connection } from 'mongoose';

import { MONGO_ENV_VARS } from '../testUtils/db';
import { configureMockEnvVars } from '../testUtils/envVars';
import { mockSpy } from '../testUtils/jest';
import { createMongooseConnectionFromEnv, getMongooseConnectionArgsFromEnv } from './mongo';

const MOCK_MONGOOSE_CONNECTION = { model: { bind: mockSpy(jest.fn()) } } as any as Connection;
const MOCK_MONGOOSE_CREATE_CONNECTION = mockSpy(
  jest.spyOn(mongoose, 'createConnection'),
  jest.fn().mockResolvedValue(MOCK_MONGOOSE_CONNECTION),
);

const mockEnvVars = configureMockEnvVars(MONGO_ENV_VARS);

describe('getMongooseConnectionArgsFromEnv', () => {
  test.each(Object.getOwnPropertyNames(MONGO_ENV_VARS))(
    'Environment variable %s should be present',
    (envVarName) => {
      mockEnvVars({ ...MONGO_ENV_VARS, [envVarName]: undefined });

      expect(getMongooseConnectionArgsFromEnv).toThrow(EnvVarError);
    },
  );

  test('Connection should use MONGO_URI', () => {
    expect(getMongooseConnectionArgsFromEnv().uri).toEqual(MONGO_ENV_VARS.MONGO_URI);
  });

  test('Connection should use MONGO_DB', () => {
    expect(getMongooseConnectionArgsFromEnv().options.dbName).toEqual(MONGO_ENV_VARS.MONGO_DB);
  });

  test('Connection should use MONGO_USER', () => {
    expect(getMongooseConnectionArgsFromEnv().options.user).toEqual(MONGO_ENV_VARS.MONGO_USER);
  });

  test('Connection should use MONGO_PASSWORD', () => {
    expect(getMongooseConnectionArgsFromEnv().options.pass).toEqual(MONGO_ENV_VARS.MONGO_PASSWORD);
  });

  test('Connection should be created with new URL parser', () => {
    expect(getMongooseConnectionArgsFromEnv().options.useNewUrlParser).toBeTrue();
  });

  test('Connection should use unified topology', () => {
    expect(getMongooseConnectionArgsFromEnv().options.useUnifiedTopology).toBeTrue();
  });
});

describe('createMongooseConnectionFromEnv', () => {
  test.each(Object.getOwnPropertyNames(MONGO_ENV_VARS))(
    'Environment variable %s should be present',
    async (envVarName) => {
      mockEnvVars({ ...MONGO_ENV_VARS, [envVarName]: undefined });

      await expect(createMongooseConnectionFromEnv()).rejects.toBeInstanceOf(EnvVarError);
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
