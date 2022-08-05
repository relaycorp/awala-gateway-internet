import {
  Certificate,
  CertificationPath,
  getRSAPublicKeyFromPrivate,
  issueGatewayCertificate,
} from '@relaycorp/relaynet-core';
import { addDays, subHours } from 'date-fns';
import { Connection } from 'mongoose';
import { initPrivateKeyStore } from './backingServices/keystore';

import { MongoCertificateStore } from './keystores/MongoCertificateStore';
import { Config, ConfigKey } from './utilities/config';

/**
 * Number of hours in the past, when a gateway certificate's validity should start.
 *
 * This is needed to account for clock drift.
 */
const CERTIFICATE_START_OFFSET_HOURS = 3;

const PRIVATE_GATEWAY_CERTIFICATE_VALIDITY_DAYS = 180;

const MIN_CERTIFICATE_TTL_DAYS = 180;
export const CERTIFICATE_TTL_DAYS = 360;

export async function retrieveOwnCertificates(
  connection: Connection,
): Promise<readonly Certificate[]> {
  const store = new MongoCertificateStore(connection);
  const config = new Config(connection);

  const id = await config.get(ConfigKey.CURRENT_ID);
  const allCertificationPaths = await store.retrieveAll(id!, id!);
  return allCertificationPaths.map((p) => p.leafCertificate);
}

export async function rotateOwnCertificate(connection: Connection): Promise<Certificate | null> {
  const store = new MongoCertificateStore(connection);
  const config = new Config(connection);
  const now = new Date();

  const id = await config.get(ConfigKey.CURRENT_ID);

  const latestCertificatePath = await store.retrieveLatest(id!, id!);

  const minExpiryDate = addDays(now, MIN_CERTIFICATE_TTL_DAYS);
  if (latestCertificatePath && minExpiryDate < latestCertificatePath.leafCertificate.expiryDate) {
    return null;
  }

  const privateKeyStore = initPrivateKeyStore(connection);
  const privateKey = await privateKeyStore.retrieveIdentityKey(id!!);
  const newCertificate = await issueGatewayCertificate({
    issuerPrivateKey: privateKey!,
    subjectPublicKey: await getRSAPublicKeyFromPrivate(privateKey!),
    validityEndDate: addDays(now, CERTIFICATE_TTL_DAYS),
    validityStartDate: subHours(now, CERTIFICATE_START_OFFSET_HOURS),
  });
  await store.save(new CertificationPath(newCertificate, []), id!);

  return newCertificate;
}

export async function issuePrivateGatewayCertificate(
  privateGatewayPublicKey: CryptoKey,
  internetGatewayPrivateKey: CryptoKey,
  internetGatewayCertificate: Certificate,
): Promise<Certificate> {
  const now = new Date();
  return issueGatewayCertificate({
    issuerCertificate: internetGatewayCertificate,
    issuerPrivateKey: internetGatewayPrivateKey,
    subjectPublicKey: privateGatewayPublicKey,
    validityEndDate: addDays(now, PRIVATE_GATEWAY_CERTIFICATE_VALIDITY_DAYS),
    validityStartDate: subHours(now, CERTIFICATE_START_OFFSET_HOURS),
  });
}
