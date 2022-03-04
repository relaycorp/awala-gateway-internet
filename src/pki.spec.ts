import {
  Certificate,
  CertificateScope,
  derSerializePublicKey,
  generateRSAKeyPair,
  getPrivateAddressFromIdentityKey,
  issueGatewayCertificate,
  MockPrivateKeyStore,
} from '@relaycorp/relaynet-core';
import { addDays, addMinutes, addSeconds, subHours, subSeconds } from 'date-fns';

import * as vault from './backingServices/vault';
import { MongoCertificateStore } from './keystores/MongoCertificateStore';
import {
  issuePrivateGatewayCertificate,
  retrieveOwnCertificates,
  rotateOwnCertificate,
} from './pki';
import { setUpTestDBConnection } from './testUtils/db';
import { mockSpy } from './testUtils/jest';
import { reSerializeCertificate } from './testUtils/pki';
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
    await certificateStore.save(certificate1, CertificateScope.PDA);

    const certs = await retrieveOwnCertificates(getMongooseConnection());

    expect(certs).toHaveLength(1);
    expect(certificate1.isEqual(certs[0])).toBeTrue();
  });

  test('Multiple certificates should be returned when there are multiple certificates', async () => {
    await certificateStore.save(certificate1, CertificateScope.PDA);
    await certificateStore.save(certificate2, CertificateScope.PDA);

    const certs = await retrieveOwnCertificates(getMongooseConnection());

    expect(certs).toHaveLength(2);
    expect(certs.filter((c) => certificate1.isEqual(c))).toHaveLength(1);
    expect(certs.filter((c) => certificate2.isEqual(c))).toHaveLength(1);
  });
});

describe('rotateOwnCertificate', () => {
  const mockPrivateKeyStore = new MockPrivateKeyStore();
  beforeEach(async () => {
    await mockPrivateKeyStore.saveIdentityKey(identityKeyPair.privateKey);
  });
  afterEach(() => {
    mockPrivateKeyStore.clear();
  });
  mockSpy(jest.spyOn(vault, 'initVaultKeyStore'), () => mockPrivateKeyStore);

  test('New certificate should be created if there are none', async () => {
    await expect(
      certificateStore.retrieveLatest(privateAddress, CertificateScope.PDA),
    ).resolves.toBeNull();

    await rotateOwnCertificate(getMongooseConnection());

    await expect(
      certificateStore.retrieveLatest(privateAddress, CertificateScope.PDA),
    ).resolves.not.toBeNull();
  });

  test('New certificate should be created if latest expires in less than 180 days', async () => {
    const cutoffDate = addDays(new Date(), 180);
    const certificate = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: subSeconds(cutoffDate, 1),
    });
    await certificateStore.save(certificate, CertificateScope.PDA);

    await rotateOwnCertificate(getMongooseConnection());

    const newCertificate = await certificateStore.retrieveLatest(
      privateAddress,
      CertificateScope.PDA,
    );
    expect(certificate.isEqual(newCertificate!!)).toBeFalse();
  });

  test('New certificate should not be created if latest expires in over 180 days', async () => {
    const cutoffDate = addDays(new Date(), 180);
    const certificate = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: addSeconds(cutoffDate, 1),
    });
    await certificateStore.save(certificate, CertificateScope.PDA);

    await expect(rotateOwnCertificate(getMongooseConnection())).resolves.toBeNull();

    const newCertificate = await certificateStore.retrieveLatest(
      privateAddress,
      CertificateScope.PDA,
    );
    expect(certificate.isEqual(newCertificate!!)).toBeTrue();
  });

  test('New certificate should be output', async () => {
    const newCertificate = await rotateOwnCertificate(getMongooseConnection());

    const latestCertificate = await certificateStore.retrieveLatest(
      privateAddress,
      CertificateScope.PDA,
    );

    expect(newCertificate!.isEqual(latestCertificate!!)).toBeTrue();
  });

  test('New certificate should be self-issued', async () => {
    await rotateOwnCertificate(getMongooseConnection());

    const certificate = await certificateStore.retrieveLatest(privateAddress, CertificateScope.PDA);
    expect(certificate!.getIssuerPrivateAddress()).toEqual(privateAddress);
  });

  test('New certificate should use existing key pair', async () => {
    await rotateOwnCertificate(getMongooseConnection());

    const certificate = await certificateStore.retrieveLatest(privateAddress, CertificateScope.PDA);
    await expect(derSerializePublicKey(await certificate!.getPublicKey())).resolves.toEqual(
      await derSerializePublicKey(identityKeyPair.publicKey),
    );
  });

  test('New certificate should be valid starting 3 hours ago', async () => {
    const expectedStartDate = subHours(new Date(), 3);

    await rotateOwnCertificate(getMongooseConnection());

    const certificate = await certificateStore.retrieveLatest(privateAddress, CertificateScope.PDA);
    expect(certificate!.startDate).toBeAfter(subSeconds(expectedStartDate, 1));
    expect(certificate!.startDate).toBeBeforeOrEqualTo(addSeconds(expectedStartDate, 10));
  });

  test('New certificate should expire in 360 days', async () => {
    await rotateOwnCertificate(getMongooseConnection());

    const certificate = await certificateStore.retrieveLatest(privateAddress, CertificateScope.PDA);
    const expectedExpiryDate = addDays(new Date(), 360);
    expect(certificate!.expiryDate).toBeBeforeOrEqualTo(expectedExpiryDate);
    expect(certificate!.expiryDate).toBeAfter(subSeconds(expectedExpiryDate, 5));
  });
});

describe('issuePrivateGatewayCertificate', () => {
  let privateGatewayPublicKey: CryptoKey;
  beforeAll(async () => {
    const privateGatewayKeyPair = await generateRSAKeyPair();
    privateGatewayPublicKey = privateGatewayKeyPair.publicKey;
  });

  let publicGatewayCertificate: Certificate;
  beforeAll(async () => {
    publicGatewayCertificate = reSerializeCertificate(
      await issueGatewayCertificate({
        issuerPrivateKey: identityKeyPair.privateKey,
        subjectPublicKey: identityKeyPair.publicKey,
        validityEndDate: addMinutes(new Date(), 3),
      }),
    );
  });

  test('Subject key should be honoured', async () => {
    const privateGatewayCertificate = await issuePrivateGatewayCertificate(
      privateGatewayPublicKey,
      identityKeyPair.privateKey,
      publicGatewayCertificate,
    );

    await expect(
      derSerializePublicKey(await privateGatewayCertificate.getPublicKey()),
    ).resolves.toEqual(await derSerializePublicKey(privateGatewayPublicKey));
  });

  test('Issuer should be public gateway', async () => {
    const privateGatewayCertificate = reSerializeCertificate(
      await issuePrivateGatewayCertificate(
        privateGatewayPublicKey,
        identityKeyPair.privateKey,
        publicGatewayCertificate,
      ),
    );

    await expect(
      privateGatewayCertificate.getCertificationPath([], [publicGatewayCertificate]),
    ).resolves.toHaveLength(2);
  });

  test('Start date should be 3 hours ago', async () => {
    const privateGatewayCertificate = await issuePrivateGatewayCertificate(
      privateGatewayPublicKey,
      identityKeyPair.privateKey,
      publicGatewayCertificate,
    );

    const expectedStartDate = subHours(new Date(), 3);
    expect(privateGatewayCertificate.startDate).toBeAfter(subSeconds(expectedStartDate, 5));
    expect(privateGatewayCertificate.startDate).toBeBefore(expectedStartDate);
  });

  test('Expiry date should be 180 days in the future', async () => {
    const privateGatewayCertificate = await issuePrivateGatewayCertificate(
      privateGatewayPublicKey,
      identityKeyPair.privateKey,
      publicGatewayCertificate,
    );

    const expectedExpiryDate = addDays(new Date(), 180);
    expect(privateGatewayCertificate.expiryDate).toBeAfter(subSeconds(expectedExpiryDate, 5));
    expect(privateGatewayCertificate.expiryDate).toBeBefore(expectedExpiryDate);
  });
});
