import { CertificationPath, issueGatewayCertificate } from '@relaycorp/relaynet-core';
import { addDays } from 'date-fns';

import { createMongooseConnectionFromEnv } from '../backingServices/mongo';
import { initPrivateKeyStore } from '../backingServices/keystore';
import { MongoCertificateStore } from '../keystores/MongoCertificateStore';
import { CERTIFICATE_TTL_DAYS } from '../pki';
import { Config, ConfigKey } from '../utilities/config';
import { configureExitHandling } from '../utilities/exitHandling';
import { makeLogger } from '../utilities/logging';

const LOGGER = makeLogger();
configureExitHandling(LOGGER);

const privateKeyStore = initPrivateKeyStore();

async function main(): Promise<void> {
  const connection = await createMongooseConnectionFromEnv();
  try {
    const certificateStore = new MongoCertificateStore(connection);

    const config = new Config(connection);
    const currentPrivateAddress = await config.get(ConfigKey.CURRENT_PRIVATE_ADDRESS);
    if (currentPrivateAddress) {
      LOGGER.info({ privateAddress: currentPrivateAddress }, `Gateway key pair already exists`);
    } else {
      await generateKeyPair(certificateStore, config);
    }
  } finally {
    await connection.close();
  }
}

async function generateKeyPair(
  certificateStore: MongoCertificateStore,
  config: Config,
): Promise<void> {
  const { privateAddress, privateKey, publicKey } = await privateKeyStore.generateIdentityKeyPair();

  const gatewayCertificate = await issueGatewayCertificate({
    issuerPrivateKey: privateKey,
    subjectPublicKey: publicKey,
    validityEndDate: addDays(new Date(), CERTIFICATE_TTL_DAYS),
  });
  await certificateStore.save(new CertificationPath(gatewayCertificate, []), privateAddress);

  await config.set(ConfigKey.CURRENT_PRIVATE_ADDRESS, privateAddress);

  LOGGER.info({ privateAddress }, 'Identity key pair was successfully generated');
}

main();
