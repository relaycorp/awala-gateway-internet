import { CertificationPath, issueGatewayCertificate } from '@relaycorp/relaynet-core';
import { addDays } from 'date-fns';
import { Connection } from 'mongoose';

import { createMongooseConnectionFromEnv } from '../backingServices/mongo';
import { initPrivateKeyStore } from '../backingServices/keystore';
import { MongoCertificateStore } from '../keystores/MongoCertificateStore';
import { CERTIFICATE_TTL_DAYS } from '../pki';
import { Config, ConfigKey } from '../utilities/config';
import { configureExitHandling } from '../utilities/exitHandling';
import { makeLogger } from '../utilities/logging';

const LOGGER = makeLogger();
configureExitHandling(LOGGER);

async function main(): Promise<void> {
  const connection = await createMongooseConnectionFromEnv();
  try {
    const certificateStore = new MongoCertificateStore(connection);

    const config = new Config(connection);
    const currentId = await config.get(ConfigKey.CURRENT_ID);
    if (currentId) {
      LOGGER.info({ id: currentId }, `Gateway key pair already exists`);
    } else {
      await generateKeyPair(certificateStore, config, connection);
    }
  } finally {
    await connection.close();
  }
}

async function generateKeyPair(
  certificateStore: MongoCertificateStore,
  config: Config,
  connection: Connection,
): Promise<void> {
  const privateKeyStore = initPrivateKeyStore(connection);
  const { id, privateKey, publicKey } = await privateKeyStore.generateIdentityKeyPair();

  const gatewayCertificate = await issueGatewayCertificate({
    issuerPrivateKey: privateKey,
    subjectPublicKey: publicKey,
    validityEndDate: addDays(new Date(), CERTIFICATE_TTL_DAYS),
  });
  await certificateStore.save(new CertificationPath(gatewayCertificate, []), id);

  await config.set(ConfigKey.CURRENT_ID, id);

  LOGGER.info({ id }, 'Identity key pair was successfully generated');
}

main();
