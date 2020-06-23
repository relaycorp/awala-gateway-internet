import { VaultPrivateKeyStore } from '@relaycorp/keystore-vault';
import { get as getEnvVar } from 'env-var';

export function initVaultKeyStore(): VaultPrivateKeyStore {
  const vaultUrl = getEnvVar('VAULT_URL').required().asString();
  const vaultToken = getEnvVar('VAULT_TOKEN').required().asString();
  const vaultKvPath = getEnvVar('VAULT_KV_PREFIX').required().asString();
  return new VaultPrivateKeyStore(vaultUrl, vaultToken, vaultKvPath);
}
