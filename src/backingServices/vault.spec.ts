import * as vaultKeyStore from '@relaycorp/keystore-vault';

import { configureMockEnvVars } from '../testUtils/envVars';
import { initVaultKeyStore } from './vault';

jest.mock('@relaycorp/keystore-vault');

const BASE_ENV_VARS = {
  VAULT_KV_PREFIX: 'kv-prefix',
  VAULT_TOKEN: 'token',
  VAULT_URL: 'http://hi.lol',
};
const mockEnvVars = configureMockEnvVars(BASE_ENV_VARS);

describe('initVaultKeyStore', () => {
  test.each(['VAULT_URL', 'VAULT_TOKEN', 'VAULT_KV_PREFIX'])(
    'Environment variable %s should be present',
    (envVar) => {
      mockEnvVars({ ...BASE_ENV_VARS, [envVar]: undefined });

      expect(initVaultKeyStore).toThrow(new RegExp(envVar));
    },
  );

  test('Key store should be returned if env vars are present', () => {
    const keyStore = initVaultKeyStore();

    expect(keyStore).toBeInstanceOf(vaultKeyStore.VaultPrivateKeyStore);
    expect(vaultKeyStore.VaultPrivateKeyStore).toBeCalledWith(
      BASE_ENV_VARS.VAULT_URL,
      BASE_ENV_VARS.VAULT_TOKEN,
      BASE_ENV_VARS.VAULT_KV_PREFIX,
    );
  });
});
