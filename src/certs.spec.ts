import {
  Certificate,
  derSerializePublicKey,
  generateRSAKeyPair,
  getPrivateAddressFromIdentityKey,
  issueGatewayCertificate,
  MockPrivateKeyStore,
} from '@relaycorp/relaynet-core';
import { addDays, addMinutes, addSeconds, subSeconds } from 'date-fns';

import { mockSpy, setUpTestDBConnection } from './_test_utils';
import * as vault from './backingServices/vault';
import { retrieveOwnCertificates, rotateCertificate } from './certs';
import { MongoCertificateStore } from './keystores/MongoCertificateStore';
import { Config, ConfigKey } from './utilities/config';

const getMongooseConnection = setUpTestDBConnection();

let identityKeyPair: CryptoKeyPair;
let privateAddress: string;
beforeAll(async () => {
  identityKeyPair = await generateRSAKeyPair();
  privateAddress = await getPrivateAddressFromIdentityKey(identityKeyPair.publicKey);
});

let certificateStore: MongoCertificateStore;
beforeEach(async () => {
  const connection = getMongooseConnection();

  certificateStore = new MongoCertificateStore(connection);

  const config = new Config(connection);
  await config.set(ConfigKey.CURRENT_PRIVATE_ADDRESS, privateAddress);
});

describe('retrieveOwnCertificates', () => {
  let certificate1: Certificate;
  let certificate2: Certificate;
  beforeAll(async () => {
    certificate1 = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: addMinutes(new Date(), 1),
    });
    certificate2 = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: addMinutes(new Date(), 3),
    });
  });

  test('An empty array should be returned when there are no certificates', async () => {
    const certs = await retrieveOwnCertificates(getMongooseConnection());

    expect(certs).toEqual([]);
  });

  test('A single certificate should be returned when there is one certificate', async () => {
    await certificateStore.save(certificate1);

    const certs = await retrieveOwnCertificates(getMongooseConnection());

    expect(certs).toHaveLength(1);
    expect(certificate1.isEqual(certs[0])).toBeTrue();
  });

  test('Multiple certificates should be returned when there are multiple certificates', async () => {
    await certificateStore.save(certificate1);
    await certificateStore.save(certificate2);

    const certs = await retrieveOwnCertificates(getMongooseConnection());

    expect(certs).toHaveLength(2);
    expect(certs.filter((c) => certificate1.isEqual(c))).toHaveLength(1);
    expect(certs.filter((c) => certificate2.isEqual(c))).toHaveLength(1);
  });
});

describe('rotateCertificate', () => {
  const mockPrivateKeyStore = new MockPrivateKeyStore();
  beforeEach(async () => {
    await mockPrivateKeyStore.saveIdentityKey(identityKeyPair.privateKey);
  });
  afterEach(() => {
    mockPrivateKeyStore.clear();
  });
  mockSpy(jest.spyOn(vault, 'initVaultKeyStore'), () => mockPrivateKeyStore);

  test('New certificate should be created if there are none', async () => {
    await expect(certificateStore.retrieveLatest(privateAddress)).resolves.toBeNull();

    await rotateCertificate(getMongooseConnection());

    await expect(certificateStore.retrieveLatest(privateAddress)).resolves.not.toBeNull();
  });

  test('New certificate should be created if latest expires in less than 180 days', async () => {
    const cutoffDate = addDays(new Date(), 180);
    const certificate = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: subSeconds(cutoffDate, 1),
    });
    await certificateStore.save(certificate);

    await rotateCertificate(getMongooseConnection());

    const newCertificate = await certificateStore.retrieveLatest(privateAddress);
    expect(certificate.isEqual(newCertificate!!)).toBeFalse();
  });

  test('New certificate should not be created if latest expires in over 180 days', async () => {
    const cutoffDate = addDays(new Date(), 180);
    const certificate = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: addSeconds(cutoffDate, 1),
    });
    await certificateStore.save(certificate);

    await expect(rotateCertificate(getMongooseConnection())).resolves.toBeNull();

    const newCertificate = await certificateStore.retrieveLatest(privateAddress);
    expect(certificate.isEqual(newCertificate!!)).toBeTrue();
  });

  test('New certificate should be output', async () => {
    const newCertificate = await rotateCertificate(getMongooseConnection());

    const latestCertificate = await certificateStore.retrieveLatest(privateAddress);

    expect(newCertificate!.isEqual(latestCertificate!!)).toBeTrue();
  });

  test('New certificate should be self-issued', async () => {
    await rotateCertificate(getMongooseConnection());

    const certificate = await certificateStore.retrieveLatest(privateAddress);
    expect(certificate!.getIssuerPrivateAddress()).toEqual(privateAddress);
  });

  test('New certificate should use existing key pair', async () => {
    await rotateCertificate(getMongooseConnection());

    const certificate = await certificateStore.retrieveLatest(privateAddress);
    await expect(derSerializePublicKey(await certificate!.getPublicKey())).resolves.toEqual(
      await derSerializePublicKey(identityKeyPair.publicKey),
    );
  });

  test('New certificate should expire in 360 days', async () => {
    await rotateCertificate(getMongooseConnection());

    const certificate = await certificateStore.retrieveLatest(privateAddress);
    const expectedExpiryDate = addDays(new Date(), 360);
    expect(certificate!.expiryDate).toBeBeforeOrEqualTo(expectedExpiryDate);
    expect(certificate!.expiryDate).toBeAfter(subSeconds(expectedExpiryDate, 5));
  });
});
