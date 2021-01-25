import {
  AdapterType,
  initObjectStoreClientWithHMACKeys,
  ObjectStoreClient,
} from '@relaycorp/object-storage';
import { get as getEnvVar } from 'env-var';

export function initObjectStoreFromEnv(): ObjectStoreClient {
  const backend = getEnvVar('OBJECT_STORE_BACKEND').required().asString();
  const endpoint = getEnvVar('OBJECT_STORE_ENDPOINT').required().asString();
  const accessKeyId = getEnvVar('OBJECT_STORE_ACCESS_KEY_ID').required().asString();
  const secretKey = getEnvVar('OBJECT_STORE_SECRET_KEY').required().asString();
  const tlsEnabled = getEnvVar('OBJECT_STORE_TLS_ENABLED').default('true').asBool();
  return initObjectStoreClientWithHMACKeys(
    backend as AdapterType,
    endpoint,
    accessKeyId,
    secretKey,
    tlsEnabled,
  );
}
