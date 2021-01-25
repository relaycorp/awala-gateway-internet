import { initObjectStoreClientWithHMACKeys } from '@relaycorp/object-storage';
import { EnvVarError } from 'env-var';

import { configureMockEnvVars } from '../services/_test_utils';
import { initObjectStoreFromEnv } from './objectStorage';

jest.mock('@relaycorp/object-storage');

describe('initFromEnv', () => {
  const requiredEnvVars = {
    OBJECT_STORE_ACCESS_KEY_ID: 'the-access-key-id',
    OBJECT_STORE_BACKEND: 'minio',
    OBJECT_STORE_ENDPOINT: 'objects.example.com:9000',
    OBJECT_STORE_SECRET_KEY: 'the-secret-key',
  };
  const mockEnvVars = configureMockEnvVars(requiredEnvVars);

  test.each(Object.getOwnPropertyNames(requiredEnvVars))(
    '%s should be required',
    (envVarKey: string) => {
      mockEnvVars({ ...requiredEnvVars, [envVarKey]: undefined });

      expect(() => initObjectStoreFromEnv()).toThrowWithMessage(EnvVarError, new RegExp(envVarKey));
    },
  );

  test('OBJECT_STORE_TLS_ENABLED should be honored if present', () => {
    mockEnvVars({ ...requiredEnvVars, OBJECT_STORE_TLS_ENABLED: 'false' });

    initObjectStoreFromEnv();

    expect(initObjectStoreClientWithHMACKeys).toBeCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      false,
    );
  });

  test('TLS should be enabled if OBJECT_STORE_TLS_ENABLED is missing', () => {
    mockEnvVars({ ...requiredEnvVars, OBJECT_STORE_TLS_ENABLED: undefined });

    initObjectStoreFromEnv();

    expect(initObjectStoreClientWithHMACKeys).toBeCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      true,
    );
  });

  test('Environment variables should be passed to constructor', () => {
    mockEnvVars({ ...requiredEnvVars, OBJECT_STORE_TLS_ENABLED: undefined });

    initObjectStoreFromEnv();

    expect(initObjectStoreClientWithHMACKeys).toBeCalledWith(
      requiredEnvVars.OBJECT_STORE_BACKEND,
      requiredEnvVars.OBJECT_STORE_ENDPOINT,
      requiredEnvVars.OBJECT_STORE_ACCESS_KEY_ID,
      requiredEnvVars.OBJECT_STORE_SECRET_KEY,
      expect.anything(),
    );
  });
});
