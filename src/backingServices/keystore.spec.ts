import { Adapter, initPrivateKeystoreFromEnv } from '@relaycorp/awala-keystore-cloud';
import { EnvVarError } from 'env-var';

import { configureMockEnvVars } from '../testUtils/envVars';
import { initPrivateKeyStore } from './keystore';

jest.mock('@relaycorp/awala-keystore-cloud');

const mockEnvVars = configureMockEnvVars();

describe('initPrivateKeyStore', () => {
  test('Environment variable KEYSTORE_ADAPTER should be present', () => {
    expect(initPrivateKeyStore).toThrowWithMessage(EnvVarError, /KEYSTORE_ADAPTER/);
  });

  test('GCP adapter should be supported', () => {
    mockEnvVars({ KEYSTORE_ADAPTER: 'gcp' });

    initPrivateKeyStore();

    expect(initPrivateKeystoreFromEnv).toBeCalledWith(Adapter.GCP);
  });

  test('Vault adapter should be supported', () => {
    mockEnvVars({ KEYSTORE_ADAPTER: 'vault' });

    initPrivateKeyStore();

    expect(initPrivateKeystoreFromEnv).toBeCalledWith(Adapter.VAULT);
  });

  test('Unsupported adapters should be refused', () => {
    mockEnvVars({ KEYSTORE_ADAPTER: 'potato' });

    expect(initPrivateKeyStore).toThrowWithMessage(EnvVarError, /KEYSTORE_ADAPTER/);
  });
});
