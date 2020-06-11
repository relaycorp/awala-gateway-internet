// tslint:disable:no-console

// tslint:disable-next-line:no-var-requires no-console
require('make-promises-safe');

import { VaultPrivateKeyStore } from '@relaycorp/keystore-vault';
import {
  generateECDHKeyPair,
  generateRSAKeyPair, issueGatewayCertificate,
  issueInitialDHKeyCertificate,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { get as getEnvVar } from 'env-var';

const NODE_CERTIFICATE_TTL_DAYS = 180;
const SESSION_CERTIFICATE_TTL_DAYS = 60;

const KEY_ID_BASE64 = getEnvVar('GATEWAY_KEY_ID').required().asString();
const vaultUrl = getEnvVar('VAULT_URL').required().asString();
const vaultToken = getEnvVar('VAULT_TOKEN').required().asString();
const vaultKvPrefix = getEnvVar('VAULT_KV_PREFIX').required().asString();
const sessionStore = new VaultPrivateKeyStore(vaultUrl, vaultToken, vaultKvPrefix);

async function main(): Promise<void> {
  const keyId = Buffer.from(KEY_ID_BASE64, 'base64');
  try {
    await sessionStore.fetchNodeKey(keyId);
    console.warn(`Gateway key ${KEY_ID_BASE64} already exists`);
    return;
  } catch (error) {
    console.log(`Gateway key will be created because it doesn't already exist`);
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
  gatewayCertificate.pkijsCertificate.serialNumber.valueBlock.valueHex = bufferToArray(
    keyId,
  );

  await sessionStore.saveNodeKey(gatewayKeyPair.privateKey, gatewayCertificate);

  const initialSessionKeyPair = await generateECDHKeyPair();
  const sessionCertEndDate = new Date();
  sessionCertEndDate.setDate(sessionCertEndDate.getDate() + SESSION_CERTIFICATE_TTL_DAYS);
  const initialKeyCertificate = await issueInitialDHKeyCertificate({
    issuerCertificate: gatewayCertificate,
    issuerPrivateKey: gatewayKeyPair.privateKey,
    subjectPublicKey: initialSessionKeyPair.publicKey,
    validityEndDate: sessionCertEndDate,
  });

  console.log(
    JSON.stringify({
      gatewayCertificate: base64Encode(gatewayCertificate.serialize()),
      initialSessionCertificate: base64Encode(initialKeyCertificate.serialize()),
      keyPairId: KEY_ID_BASE64,
    }),
  );
}

function base64Encode(payload: ArrayBuffer | Buffer): string {
  return Buffer.from(payload).toString('base64');
}

main();
