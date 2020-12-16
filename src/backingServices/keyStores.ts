import { VaultPrivateKeyStore } from '@relaycorp/keystore-vault';
import { PublicKeyStore } from '@relaycorp/relaynet-core';
import { get as getEnvVar } from 'env-var';
import { Connection } from 'mongoose';
import { MongoPublicKeyStore } from '../services/MongoPublicKeyStore';

export function initVaultKeyStore(): VaultPrivateKeyStore {
  const vaultUrl = getEnvVar('VAULT_URL').required().asString();
  const vaultToken = getEnvVar('VAULT_TOKEN').required().asString();
  const vaultKvPath = getEnvVar('VAULT_KV_PREFIX').required().asString();
  return new VaultPrivateKeyStore(vaultUrl, vaultToken, vaultKvPath);
}

/**
 * Return the public key store used by the gateway.
 *
 * @param connection
 *
 * This function exists primarily to make it easy to replace the MongoDB store with a mock one in
 * unit tests.
 */
export function initMongoDBKeyStore(connection: Connection): PublicKeyStore {
  return new MongoPublicKeyStore(connection);
}
