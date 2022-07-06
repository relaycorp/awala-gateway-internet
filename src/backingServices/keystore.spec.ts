import { Adapter, initPrivateKeystoreFromEnv } from '@relaycorp/awala-keystore-cloud';
import { EnvVarError } from 'env-var';
import { Connection } from 'mongoose';

import { configureMockEnvVars } from '../testUtils/envVars';
import { initPrivateKeyStore } from './keystore';

jest.mock('@relaycorp/awala-keystore-cloud');

const mockEnvVars = configureMockEnvVars();

describe('initPrivateKeyStore', () => {
  const MOCK_CONNECTION: Connection = Symbol() as any;

  test('Environment variable KEYSTORE_ADAPTER should be present', () => {
    expect(() => initPrivateKeyStore(MOCK_CONNECTION)).toThrowWithMessage(
      EnvVarError,
      /KEYSTORE_ADAPTER/,
    );
  });

  describe('Adapter', () => {
    test('GCP adapter should be supported', () => {
      mockEnvVars({ KEYSTORE_ADAPTER: 'gcp' });

      initPrivateKeyStore(MOCK_CONNECTION);

      expect(initPrivateKeystoreFromEnv).toBeCalledWith(Adapter.GCP, expect.anything());
    });

    test('Vault adapter should be supported', () => {
      mockEnvVars({ KEYSTORE_ADAPTER: 'vault' });

      initPrivateKeyStore(MOCK_CONNECTION);

      expect(initPrivateKeystoreFromEnv).toBeCalledWith(Adapter.VAULT, expect.anything());
    });

    test('Unsupported adapters should be refused', () => {
      mockEnvVars({ KEYSTORE_ADAPTER: 'potato' });

      expect(initPrivateKeyStore).toThrowWithMessage(EnvVarError, /KEYSTORE_ADAPTER/);
    });
  });

  test('MongoDB connection should be passed on', () => {
    mockEnvVars({ KEYSTORE_ADAPTER: 'gcp' });

    initPrivateKeyStore(MOCK_CONNECTION);

    expect(initPrivateKeystoreFromEnv).toBeCalledWith(expect.anything(), MOCK_CONNECTION);
  });
});
