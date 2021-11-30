import { generateRSAKeyPair, issueGatewayCertificate } from '@relaycorp/relaynet-core';
import { addDays } from 'date-fns';

import { createMongooseConnectionFromEnv } from '../backingServices/mongo';
import { initVaultKeyStore } from '../backingServices/vault';
import { MongoCertificateStore } from '../keystores/MongoCertificateStore';
import { Config, ConfigKey } from '../utilities/config';
import { configureExitHandling } from '../utilities/exitHandling';
import { makeLogger } from '../utilities/logging';

const LOGGER = makeLogger();
configureExitHandling(LOGGER);

const NODE_CERTIFICATE_TTL_DAYS = 360;

const privateKeyStore = initVaultKeyStore();

async function main(): Promise<void> {
  const connection = await createMongooseConnectionFromEnv();
  const config = new Config(connection);

  const currentPrivateAddress = await config.get(ConfigKey.CURRENT_PRIVATE_ADDRESS);
  if (currentPrivateAddress) {
    LOGGER.info({ privateAddress: currentPrivateAddress }, `Gateway key pair already exists`);
    return;
  }
  LOGGER.info(`Gateway key will be created because it doesn't already exist`);

  const gatewayKeyPair = await generateRSAKeyPair();
  const privateAddress = await privateKeyStore.saveIdentityKey(gatewayKeyPair.privateKey);

  const certificateStore = new MongoCertificateStore(connection);
  const gatewayCertificate = await issueGatewayCertificate({
    issuerPrivateKey: gatewayKeyPair.privateKey,
    subjectPublicKey: gatewayKeyPair.publicKey,
    validityEndDate: addDays(new Date(), NODE_CERTIFICATE_TTL_DAYS),
  });
  await certificateStore.save(gatewayCertificate);

  await config.set(ConfigKey.CURRENT_PRIVATE_ADDRESS, privateAddress);

  LOGGER.info({ privateAddress }, 'Identity key pair was successfully generated');
}

main();
