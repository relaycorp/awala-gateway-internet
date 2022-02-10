import { Certificate, issueGatewayCertificate } from '@relaycorp/relaynet-core';
import { addDays } from 'date-fns';
import { Connection } from 'mongoose';
import { initVaultKeyStore } from './backingServices/vault';

import { MongoCertificateStore } from './keystores/MongoCertificateStore';
import { Config, ConfigKey } from './utilities/config';

const MIN_CERTIFICATE_TTL_DAYS = 180;
export const CERTIFICATE_TTL_DAYS = 360;

export async function retrieveOwnCertificates(
  connection: Connection,
): Promise<readonly Certificate[]> {
  const store = new MongoCertificateStore(connection);
  const config = new Config(connection);

  const privateAddress = await config.get(ConfigKey.CURRENT_PRIVATE_ADDRESS);
  return store.retrieveAll(privateAddress!!);
}

export async function rotateCertificate(connection: Connection): Promise<void> {
  const store = new MongoCertificateStore(connection);
  const config = new Config(connection);

  const privateAddress = await config.get(ConfigKey.CURRENT_PRIVATE_ADDRESS);

  const latestCertificate = await store.retrieveLatest(privateAddress!!);

  const minExpiryDate = addDays(new Date(), MIN_CERTIFICATE_TTL_DAYS);
  if (latestCertificate && minExpiryDate < latestCertificate.expiryDate) {
    return;
  }

  const privateKeyStore = initVaultKeyStore();
  const privateKey = await privateKeyStore.retrieveIdentityKey(privateAddress!!);
  const newCertificate = await issueGatewayCertificate({
    issuerPrivateKey: privateKey,
    subjectPublicKey: privateKey,
    validityEndDate: addDays(new Date(), CERTIFICATE_TTL_DAYS),
  });
  await store.save(newCertificate);
}
