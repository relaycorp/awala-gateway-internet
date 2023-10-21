import envVar from 'env-var';
import type { ConnectOptions } from 'mongoose';

import { mockSpy } from '../testUtils/jest';

const MOCK_MONGOOSE_CONNECTION = { model: { bind: mockSpy(jest.fn()) } } as any;
const MOCK_MONGOOSE_CREATE_CONNECTION = jest.fn().mockReturnValue(MOCK_MONGOOSE_CONNECTION);
jest.mock('mongoose', () => ({
  createConnection: MOCK_MONGOOSE_CREATE_CONNECTION,
}));
import { createMongooseConnectionFromEnv } from './mongo';
import { configureMockEnvVars } from '../testUtils/envVars';

const MONGODB_DB = 'the-db';
const MONGODB_USER = 'alicia';
const MONGODB_PASSWORD = 'letmein';

const MONGODB_URI = 'mongodb://example.com';
const MONGO_ENV_VARS = { MONGODB_URI };
const mockEnvVars = configureMockEnvVars(MONGO_ENV_VARS);

describe('createMongooseConnectionFromEnv', () => {
  test.each(Object.getOwnPropertyNames(MONGO_ENV_VARS))(
    'Environment variable %s should be present',
    (envVarName) => {
      mockEnvVars({ ...MONGO_ENV_VARS, [envVarName]: undefined });

      expect(createMongooseConnectionFromEnv).toThrow(envVar.EnvVarError);
    },
  );

  test('Connection should use MONGODB_URI', () => {
    createMongooseConnectionFromEnv();

    expect(MOCK_MONGOOSE_CREATE_CONNECTION).toHaveBeenCalledWith(
      MONGO_ENV_VARS.MONGODB_URI,
      expect.anything(),
    );
  });

  test.each([
    ['dbName', 'MONGODB_DB', MONGODB_DB],
    ['user', 'MONGODB_USER', MONGODB_USER],
    ['pass', 'MONGODB_PASSWORD', MONGODB_PASSWORD],
  ])('%s should be taken from %s if specified', (optionName, envVarName, envVarValue) => {
    mockEnvVars({ [envVarName]: envVarValue, ...MONGO_ENV_VARS });

    createMongooseConnectionFromEnv();

    expect(MOCK_MONGOOSE_CREATE_CONNECTION).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining<ConnectOptions>({ [optionName]: envVarValue }),
    );
  });

  test.each([
    ['dbName', 'MONGODB_DB'],
    ['user', 'MONGODB_USER'],
    ['pass', 'MONGODB_PASSWORD'],
  ])('%s should be absent if %s is unspecified', (optionName, envVarName) => {
    mockEnvVars({ ...MONGO_ENV_VARS, [envVarName]: undefined });

    createMongooseConnectionFromEnv();

    expect(MOCK_MONGOOSE_CREATE_CONNECTION).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.toContainKeys([optionName]),
    );
  });

  test.each([
    ['serverSelectionTimeoutMS', 3000],
    ['connectTimeoutMS', 3000],
    ['maxIdleTimeMS', 60_000],
  ])('Timeout setting %s should be set to %d', (optionName, expectedValue) => {
    createMongooseConnectionFromEnv();

    expect(MOCK_MONGOOSE_CREATE_CONNECTION).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ [optionName]: expectedValue }),
    );
  });

  test('Mongoose connection should be returned', () => {
    const connection = createMongooseConnectionFromEnv();

    expect(connection).toBe(MOCK_MONGOOSE_CONNECTION);
  });
});
