import { Certificate, generateRSAKeyPair, issueGatewayCertificate } from '@relaycorp/relaynet-core';
import { getModelForClass } from '@typegoose/typegoose';
import bufferToArray from 'buffer-to-arraybuffer';
import { get as getEnvVar } from 'env-var';

import { createMongooseConnectionFromEnv } from '../backingServices/mongo';
import { initVaultKeyStore } from '../backingServices/vault';
import { OwnCertificate } from '../models';
import { configureExitHandling } from '../utilities/exitHandling';
import { makeLogger } from '../utilities/logging';

const LOGGER = makeLogger();
configureExitHandling(LOGGER);

const NODE_CERTIFICATE_TTL_DAYS = 360;

const KEY_ID_BASE64 = getEnvVar('GATEWAY_KEY_ID').required().asString();

const privateKeyStore = initVaultKeyStore();

async function main(): Promise<void> {
  const keyId = Buffer.from(KEY_ID_BASE64, 'base64');
  try {
    await privateKeyStore.fetchNodeKey(keyId);
    LOGGER.warn(`Gateway key ${KEY_ID_BASE64} already exists`);
    return;
  } catch (error) {
    LOGGER.info(`Gateway key will be created because it doesn't already exist`);
  }

  const gatewayKeyPair = await generateRSAKeyPair();

  const nodeCertEndDate = new Date();
  nodeCertEndDate.setDate(nodeCertEndDate.getDate() + NODE_CERTIFICATE_TTL_DAYS);
  const gatewayCertificate = await issueGatewayCertificate({
    issuerPrivateKey: gatewayKeyPair.privateKey,
    subjectPublicKey: gatewayKeyPair.publicKey,
    validityEndDate: nodeCertEndDate,
  });
  // Force the certificate to have the serial number specified in GATEWAY_KEY_ID. This nasty
  // hack won't be necessary once https://github.com/relaycorp/relaynet-internet-gateway/issues/49
  // is done.
  // tslint:disable-next-line:no-object-mutation
  (gatewayCertificate as any).pkijsCertificate.serialNumber.valueBlock.valueHex =
    bufferToArray(keyId);

  await privateKeyStore.saveNodeKey(gatewayKeyPair.privateKey, gatewayCertificate);
  await saveOwnCertificate(gatewayCertificate);

  LOGGER.info(
    {
      gatewayCertificate: base64Encode(gatewayCertificate.serialize()),
      keyPairId: KEY_ID_BASE64,
    },
    'Identity key pair was successfully generated',
  );
}

async function saveOwnCertificate(certificate: Certificate): Promise<void> {
  const connection = await createMongooseConnectionFromEnv();
  const ownCertificateModel = getModelForClass(OwnCertificate, { existingConnection: connection });
  await ownCertificateModel.create({ serializationDer: Buffer.from(certificate.serialize()) });
  await connection.close();
}

function base64Encode(payload: ArrayBuffer | Buffer): string {
  return Buffer.from(payload).toString('base64');
}

main();
