import * as vaultKeyStore from '@relaycorp/keystore-vault';
import { Connection } from 'mongoose';

import { configureMockEnvVars } from '../services/_test_utils';
import { MongoPublicKeyStore } from '../services/MongoPublicKeyStore';
import { initMongoDBKeyStore, initVaultKeyStore } from './keyStores';

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

describe('initMongoDBKeyStore', () => {
  const mongooseConnection = ({ model: { bind: jest.fn() } } as any) as Connection;

  test('MongoPublicKeyStore instance should be returned', () => {
    const keyStore = initMongoDBKeyStore(mongooseConnection);

    expect(keyStore).toBeInstanceOf(MongoPublicKeyStore);
  });
});
