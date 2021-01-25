import { AdapterType, initObjectStoreClient, ObjectStoreClient } from '@relaycorp/object-storage';
import { get as getEnvVar } from 'env-var';

export function initObjectStoreFromEnv(): ObjectStoreClient {
  const backend = getEnvVar('OBJECT_STORE_BACKEND').required().asString();
  const endpoint = getEnvVar('OBJECT_STORE_ENDPOINT').asString();
  const accessKeyId = getEnvVar('OBJECT_STORE_ACCESS_KEY_ID').asString();
  const secretKey = getEnvVar('OBJECT_STORE_SECRET_KEY').asString();
  const tlsEnabled = getEnvVar('OBJECT_STORE_TLS_ENABLED').default('true').asBool();
  return initObjectStoreClient(
    backend as AdapterType,
    endpoint,
    accessKeyId,
    secretKey,
    tlsEnabled,
  );
}
