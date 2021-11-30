import { Certificate, generateRSAKeyPair, issueGatewayCertificate } from '@relaycorp/relaynet-core';
import { getModelForClass } from '@typegoose/typegoose';
import bufferToArray from 'buffer-to-arraybuffer';
import { addDays } from 'date-fns';
import { Connection } from 'mongoose';

import { createMongooseConnectionFromEnv } from '../backingServices/mongo';
import { initVaultKeyStore } from '../backingServices/vault';
import { MongoCertificateStore } from '../keystores/MongoCertificateStore';
import { OwnCertificate } from '../models';
import { Config, ConfigKey } from '../utilities/config';
import { configureExitHandling } from '../utilities/exitHandling';
import { makeLogger } from '../utilities/logging';

const LOGGER = makeLogger();
configureExitHandling(LOGGER);

const NODE_CERTIFICATE_TTL_DAYS = 360;

const privateKeyStore = initVaultKeyStore();

async function main(): Promise<void> {
  const connection = await createMongooseConnectionFromEnv();
  try {
    const certificateStore = new MongoCertificateStore(connection);

    await generateKeyPair(connection, certificateStore);
    await migrateDeprecatedCertificates(connection, certificateStore);
  } finally {
    await connection.close();
  }
}

async function generateKeyPair(
  connection: Connection,
  certificateStore: MongoCertificateStore,
): Promise<void> {
  const config = new Config(connection);
  const currentPrivateAddress = await config.get(ConfigKey.CURRENT_PRIVATE_ADDRESS);
  if (currentPrivateAddress) {
    LOGGER.info({ privateAddress: currentPrivateAddress }, `Gateway key pair already exists`);
    return;
  }
  LOGGER.info(`Gateway key will be created because it doesn't already exist`);

  const gatewayKeyPair = await generateRSAKeyPair();
  const privateAddress = await privateKeyStore.saveIdentityKey(gatewayKeyPair.privateKey);

  const gatewayCertificate = await issueGatewayCertificate({
    issuerPrivateKey: gatewayKeyPair.privateKey,
    subjectPublicKey: gatewayKeyPair.publicKey,
    validityEndDate: addDays(new Date(), NODE_CERTIFICATE_TTL_DAYS),
  });
  await certificateStore.save(gatewayCertificate);

  await config.set(ConfigKey.CURRENT_PRIVATE_ADDRESS, privateAddress);

  LOGGER.info({ privateAddress }, 'Identity key pair was successfully generated');
}

// TODO: Delete once we've deployed it to Frankfurt
async function migrateDeprecatedCertificates(
  connection: Connection,
  certificateStore: MongoCertificateStore,
): Promise<void> {
  const deprecatedCertificateModel = getModelForClass(OwnCertificate, {
    existingConnection: connection,
  });
  const deprecatedCertificateRecords = await deprecatedCertificateModel.find({});
  const deprecatedCertificates = deprecatedCertificateRecords.map((c) =>
    Certificate.deserialize(bufferToArray(c.serializationDer)),
  );

  await Promise.all(deprecatedCertificates.map((c) => certificateStore.save(c)));

  await deprecatedCertificateModel.deleteMany({});

  LOGGER.info(
    { deprecatedCertificates: deprecatedCertificates.length },
    'Migrated deprecated certificates',
  );
}

main();
