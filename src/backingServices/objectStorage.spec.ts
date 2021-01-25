import { initObjectStoreClient } from '@relaycorp/object-storage';
import { EnvVarError } from 'env-var';

import { configureMockEnvVars } from '../services/_test_utils';
import { initObjectStoreFromEnv } from './objectStorage';

jest.mock('@relaycorp/object-storage');

describe('initFromEnv', () => {
  const envVars = {
    OBJECT_STORE_ACCESS_KEY_ID: 'the-access-key-id',
    OBJECT_STORE_BACKEND: 'minio',
    OBJECT_STORE_ENDPOINT: 'objects.example.com:9000',
    OBJECT_STORE_SECRET_KEY: 'the-secret-key',
  };
  const mockEnvVars = configureMockEnvVars(envVars);

  test('OBJECT_STORE_BACKEND should be required', () => {
    mockEnvVars({});

    expect(() => initObjectStoreFromEnv()).toThrowWithMessage(EnvVarError, /OBJECT_STORE_BACKEND/);
  });

  test('OBJECT_STORE_ENDPOINT should be optional', () => {
    mockEnvVars({ ...envVars, OBJECT_STORE_ENDPOINT: undefined });

    initObjectStoreFromEnv();

    expect(initObjectStoreClient).toBeCalledWith(
      expect.anything(),
      undefined,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  test('Credentials should be optional', () => {
    mockEnvVars({
      ...envVars,
      OBJECT_STORE_ACCESS_KEY_ID: undefined,
      OBJECT_STORE_SECRET_KEY: undefined,
    });

    initObjectStoreFromEnv();

    expect(initObjectStoreClient).toBeCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      undefined,
      expect.anything(),
    );
  });

  test('OBJECT_STORE_TLS_ENABLED should be honored if present', () => {
    mockEnvVars({ ...envVars, OBJECT_STORE_TLS_ENABLED: 'false' });

    initObjectStoreFromEnv();

    expect(initObjectStoreClient).toBeCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      false,
    );
  });

  test('TLS should be enabled if OBJECT_STORE_TLS_ENABLED is missing', () => {
    mockEnvVars({ ...envVars, OBJECT_STORE_TLS_ENABLED: undefined });

    initObjectStoreFromEnv();

    expect(initObjectStoreClient).toBeCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      true,
    );
  });

  test('Environment variables should be passed to constructor', () => {
    mockEnvVars({ ...envVars });

    initObjectStoreFromEnv();

    expect(initObjectStoreClient).toBeCalledWith(
      envVars.OBJECT_STORE_BACKEND,
      envVars.OBJECT_STORE_ENDPOINT,
      envVars.OBJECT_STORE_ACCESS_KEY_ID,
      envVars.OBJECT_STORE_SECRET_KEY,
      expect.anything(),
    );
  });
});
