import {
  Certificate,
  CertificationPath,
  derSerializePublicKey,
  generateRSAKeyPair,
  getIdFromIdentityKey,
  issueGatewayCertificate,
  MockPrivateKeyStore,
} from '@relaycorp/relaynet-core';
import { addDays, addMinutes, addSeconds, setMilliseconds, subHours, subSeconds } from 'date-fns';

import * as keystore from './backingServices/keystore';
import {
  CERTIFICATE_TTL_DAYS,
  issuePrivateGatewayCertificate,
  retrieveOwnCertificates,
  rotateOwnCertificate,
} from './pki';
import { setUpTestDBConnection } from './testUtils/db';
import { mockSpy } from './testUtils/jest';
import { reSerializeCertificate } from './testUtils/pki';
import { Config, ConfigKey } from './utilities/config';
import { MongoCertificateStore } from '@relaycorp/awala-keystore-mongodb';

const getMongooseConnection = setUpTestDBConnection();

let identityKeyPair: CryptoKeyPair;
let gatewayId: string;
beforeAll(async () => {
  identityKeyPair = await generateRSAKeyPair();
  gatewayId = await getIdFromIdentityKey(identityKeyPair.publicKey);
});

let certificateStore: MongoCertificateStore;
beforeEach(async () => {
  const connection = getMongooseConnection();

  certificateStore = new MongoCertificateStore(connection);

  const config = new Config(connection);
  await config.set(ConfigKey.CURRENT_ID, gatewayId);
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
    await certificateStore.save(new CertificationPath(certificate1, []), gatewayId);

    const certs = await retrieveOwnCertificates(getMongooseConnection());

    expect(certs).toHaveLength(1);
    expect(certificate1.isEqual(certs[0])).toBeTrue();
  });

  test('Multiple certificates should be returned when there are multiple certificates', async () => {
    await certificateStore.save(new CertificationPath(certificate1, []), gatewayId);
    await certificateStore.save(new CertificationPath(certificate2, []), gatewayId);

    const certs = await retrieveOwnCertificates(getMongooseConnection());

    expect(certs).toHaveLength(2);
    expect(certs.filter((c) => certificate1.isEqual(c))).toHaveLength(1);
    expect(certs.filter((c) => certificate2.isEqual(c))).toHaveLength(1);
  });
});

describe('rotateOwnCertificate', () => {
  const mockPrivateKeyStore = new MockPrivateKeyStore();
  beforeEach(async () => {
    await mockPrivateKeyStore.saveIdentityKey(gatewayId, identityKeyPair.privateKey);
  });
  afterEach(() => {
    mockPrivateKeyStore.clear();
  });
  mockSpy(jest.spyOn(keystore, 'initPrivateKeyStore'), () => mockPrivateKeyStore);

  test('New certificate should be created if there are none', async () => {
    await expect(certificateStore.retrieveLatest(gatewayId, gatewayId)).resolves.toBeNull();

    await rotateOwnCertificate(getMongooseConnection());

    await expect(certificateStore.retrieveLatest(gatewayId, gatewayId)).resolves.not.toBeNull();
  });

  test('New certificate should be created if latest expires in less than 180 days', async () => {
    const cutoffDate = addDays(new Date(), 180);
    const oldCertificate = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: subSeconds(cutoffDate, 1),
    });
    await certificateStore.save(new CertificationPath(oldCertificate, []), gatewayId);

    await rotateOwnCertificate(getMongooseConnection());

    const newCertificationPath = await certificateStore.retrieveLatest(gatewayId, gatewayId);
    expect(oldCertificate.isEqual(newCertificationPath!.leafCertificate)).toBeFalse();
  });

  test('New certificate should not be created if latest expires in over 180 days', async () => {
    const cutoffDate = addDays(new Date(), 180);
    const oldCertificate = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: addSeconds(
        cutoffDate,
        10, // Be generous -- GitHub Actions are too slow
      ),
    });
    await certificateStore.save(new CertificationPath(oldCertificate, []), gatewayId);

    await expect(rotateOwnCertificate(getMongooseConnection())).resolves.toBeNull();

    const newCertificationPath = await certificateStore.retrieveLatest(gatewayId, gatewayId);
    expect(oldCertificate.isEqual(newCertificationPath!.leafCertificate)).toBeTrue();
  });

  test('New certificate should be output', async () => {
    const newCertificate = await rotateOwnCertificate(getMongooseConnection());

    const latestCertificationPath = await certificateStore.retrieveLatest(gatewayId, gatewayId);

    expect(newCertificate!.isEqual(latestCertificationPath!.leafCertificate)).toBeTrue();
  });

  test('New certificate should be self-issued', async () => {
    await rotateOwnCertificate(getMongooseConnection());

    const certificationPath = await certificateStore.retrieveLatest(gatewayId, gatewayId);
    expect(certificationPath!.leafCertificate.getIssuerId()).toEqual(gatewayId);
  });

  test('New certificate should use existing key pair', async () => {
    await rotateOwnCertificate(getMongooseConnection());

    const path = await certificateStore.retrieveLatest(gatewayId, gatewayId);
    await expect(
      derSerializePublicKey(await path!.leafCertificate.getPublicKey()),
    ).resolves.toEqual(await derSerializePublicKey(identityKeyPair.publicKey));
  });

  test('New certificate should be valid starting 3 hours ago', async () => {
    const expectedStartDate = subHours(new Date(), 3);

    await rotateOwnCertificate(getMongooseConnection());

    const path = await certificateStore.retrieveLatest(gatewayId, gatewayId);
    expect(path!.leafCertificate.startDate).toBeAfter(subSeconds(expectedStartDate, 1));
    expect(path!.leafCertificate.startDate).toBeBeforeOrEqualTo(addSeconds(expectedStartDate, 10));
  });

  test('New certificate should expire in 360 days', async () => {
    await rotateOwnCertificate(getMongooseConnection());

    const path = await certificateStore.retrieveLatest(gatewayId, gatewayId);
    const expectedExpiryDate = addDays(new Date(), 360);
    expect(path!.leafCertificate.expiryDate).toBeBeforeOrEqualTo(expectedExpiryDate);
    expect(path!.leafCertificate.expiryDate).toBeAfter(subSeconds(expectedExpiryDate, 5));
  });
});

describe('issuePrivateGatewayCertificate', () => {
  let privateGatewayPublicKey: CryptoKey;
  beforeAll(async () => {
    const privateGatewayKeyPair = await generateRSAKeyPair();
    privateGatewayPublicKey = privateGatewayKeyPair.publicKey;
  });

  let internetGatewayCertificate: Certificate;
  beforeAll(async () => {
    internetGatewayCertificate = reSerializeCertificate(
      await issueGatewayCertificate({
        issuerPrivateKey: identityKeyPair.privateKey,
        subjectPublicKey: identityKeyPair.publicKey,
        validityEndDate: addDays(new Date(), CERTIFICATE_TTL_DAYS),
      }),
    );
  });

  test('Subject key should be honoured', async () => {
    const privateGatewayCertificate = await issuePrivateGatewayCertificate(
      privateGatewayPublicKey,
      identityKeyPair.privateKey,
      internetGatewayCertificate,
    );

    await expect(
      derSerializePublicKey(await privateGatewayCertificate.getPublicKey()),
    ).resolves.toEqual(await derSerializePublicKey(privateGatewayPublicKey));
  });

  test('Issuer should be Internet gateway', async () => {
    const privateGatewayCertificate = reSerializeCertificate(
      await issuePrivateGatewayCertificate(
        privateGatewayPublicKey,
        identityKeyPair.privateKey,
        internetGatewayCertificate,
      ),
    );

    await expect(
      privateGatewayCertificate.getCertificationPath([], [internetGatewayCertificate]),
    ).resolves.toHaveLength(2);
  });

  test('Start date should be 3 hours ago', async () => {
    const dateBeforeIssuance = new Date();
    const privateGatewayCertificate = await issuePrivateGatewayCertificate(
      privateGatewayPublicKey,
      identityKeyPair.privateKey,
      internetGatewayCertificate,
    );

    const expectedStartDate = subHours(dateBeforeIssuance, 3);
    expect(privateGatewayCertificate.startDate).toBeAfterOrEqualTo(
      setMilliseconds(expectedStartDate, 0),
    );
    expect(privateGatewayCertificate.startDate).toBeBeforeOrEqualTo(expectedStartDate);
  });

  test('Expiry date should be 180 days in the future', async () => {
    const privateGatewayCertificate = await issuePrivateGatewayCertificate(
      privateGatewayPublicKey,
      identityKeyPair.privateKey,
      internetGatewayCertificate,
    );

    const expectedExpiryDate = addDays(new Date(), 180);
    expect(privateGatewayCertificate.expiryDate).toBeAfter(subSeconds(expectedExpiryDate, 5));
    expect(privateGatewayCertificate.expiryDate).toBeBefore(expectedExpiryDate);
  });
});
