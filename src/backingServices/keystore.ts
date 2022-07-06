import {
  Adapter,
  CloudPrivateKeystore,
  initPrivateKeystoreFromEnv,
} from '@relaycorp/awala-keystore-cloud';
import { get as getEnvVar } from 'env-var';
import { Connection } from 'mongoose';

const ADAPTER_BY_NAME: { readonly [key: string]: Adapter } = {
  gcp: Adapter.GCP,
  vault: Adapter.VAULT,
};
const VALID_ADAPTER_NAMES = Object.getOwnPropertyNames(ADAPTER_BY_NAME);

export function initPrivateKeyStore(dbConnection: Connection): CloudPrivateKeystore {
  const adapterName = getEnvVar('KEYSTORE_ADAPTER').required().asEnum(VALID_ADAPTER_NAMES);
  const adapter = ADAPTER_BY_NAME[adapterName];
  return initPrivateKeystoreFromEnv(adapter, dbConnection);
}
