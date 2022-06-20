import {
  Certificate,
  CertificationPath,
  generateRSAKeyPair,
  getPrivateAddressFromIdentityKey,
  issueGatewayCertificate,
} from '@relaycorp/relaynet-core';
import { getModelForClass, ReturnModelType } from '@typegoose/typegoose';
import { addDays, addSeconds, subSeconds } from 'date-fns';

import { CertificationPath as CertificationPathModel } from '../models';
import { setUpTestDBConnection } from '../testUtils/db';
import { MongoCertificateStore } from './MongoCertificateStore';

const getConnection = setUpTestDBConnection();
let certificateModel: ReturnModelType<typeof CertificationPathModel>;
let store: MongoCertificateStore;
beforeAll(async () => {
  const connection = getConnection();
  certificateModel = getModelForClass(CertificationPathModel, { existingConnection: connection });
  store = new MongoCertificateStore(connection);
});

let identityKeyPair: CryptoKeyPair;
let subjectPrivateAddress: string;
let validCertificate: Certificate;
let validCertificationPath: CertificationPath;
let expiredCertificate: Certificate;
let expiredCertificationPath: CertificationPath;
beforeAll(async () => {
  identityKeyPair = await generateRSAKeyPair();
  subjectPrivateAddress = await getPrivateAddressFromIdentityKey(identityKeyPair.publicKey);

  validCertificate = await issueGatewayCertificate({
    issuerPrivateKey: identityKeyPair.privateKey,
    subjectPublicKey: identityKeyPair.publicKey,
    validityEndDate: addSeconds(new Date(), 15),
  });
  validCertificationPath = new CertificationPath(validCertificate, []);

  expiredCertificate = await issueGatewayCertificate({
    issuerPrivateKey: identityKeyPair.privateKey,
    subjectPublicKey: identityKeyPair.publicKey,
    validityEndDate: subSeconds(new Date(), 1),
    validityStartDate: subSeconds(new Date(), 2),
  });
  expiredCertificationPath = new CertificationPath(expiredCertificate, []);
});

describe('saveData', () => {
  test('All attributes should be saved', async () => {
    await store.save(validCertificationPath, subjectPrivateAddress);

    const certificateStored = await certificateModel.findOne({ subjectPrivateAddress }).exec();
    expect(certificateStored).toMatchObject<Partial<CertificationPathModel>>({
      expiryDate: validCertificate.expiryDate,
      issuerPrivateAddress: subjectPrivateAddress,
      pathSerialized: Buffer.from(validCertificationPath.serialize()),
    });
  });

  test('The same subject should be allowed to have multiple certificates', async () => {
    const certificate2 = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: addDays(validCertificate.expiryDate, 1),
    });
    const certificationPath2 = new CertificationPath(certificate2, []);

    await store.save(validCertificationPath, subjectPrivateAddress);
    await store.save(certificationPath2, subjectPrivateAddress);

    const certificateRecords = await certificateModel.find({ subjectPrivateAddress }).exec();
    expect(certificateRecords).toHaveLength(2);
    expect(certificateRecords[0]).toMatchObject<Partial<CertificationPathModel>>({
      expiryDate: validCertificate.expiryDate,
      pathSerialized: Buffer.from(validCertificationPath.serialize()),
    });
    expect(certificateRecords[1]).toMatchObject<Partial<CertificationPathModel>>({
      expiryDate: certificate2.expiryDate,
      pathSerialized: Buffer.from(certificationPath2.serialize()),
    });
  });

  test('Certificates with the same subject and expiry should be deduped within same scope', async () => {
    const certificate2 = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: validCertificate.expiryDate,
    });
    const certificationPath2 = new CertificationPath(certificate2, []);

    await store.save(validCertificationPath, subjectPrivateAddress);
    await store.save(certificationPath2, subjectPrivateAddress);

    const certificateRecords = await certificateModel.find({ subjectPrivateAddress }).exec();
    expect(certificateRecords).toHaveLength(1);
    expect(certificateRecords[0]).toMatchObject<Partial<CertificationPathModel>>({
      expiryDate: certificate2.expiryDate,
      pathSerialized: Buffer.from(certificationPath2.serialize()),
    });
  });

  test('Certificates with the same subject and expiry should not be deduped across scopes', async () => {
    const certificate2 = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: validCertificate.expiryDate,
    });

    await store.save(validCertificationPath, subjectPrivateAddress);
    await store.save(new CertificationPath(certificate2, []), subjectPrivateAddress);

    await expect(
      certificateModel
        .find({ subjectPrivateAddress, issuerPrivateAddress: subjectPrivateAddress })
        .exec(),
    ).resolves.toHaveLength(1);
    await expect(
      certificateModel
        .find({ subjectPrivateAddress, issuerPrivateAddress: subjectPrivateAddress })
        .exec(),
    ).resolves.toHaveLength(1);
  });
});

describe('retrieveLatestSerialization', () => {
  test('Nothing should be returned if subject has no certificates', async () => {
    await expect(
      store.retrieveLatest(subjectPrivateAddress, subjectPrivateAddress),
    ).resolves.toBeNull();
  });

  test('Expired certificates should not be returned', async () => {
    await store.save(expiredCertificationPath, subjectPrivateAddress);

    await expect(
      store.retrieveLatest(subjectPrivateAddress, subjectPrivateAddress),
    ).resolves.toBeNull();
  });

  test('The latest valid certificate should be returned', async () => {
    await store.save(validCertificationPath, subjectPrivateAddress);
    const newestCertificate = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: addSeconds(validCertificate.expiryDate, 1),
    });
    await store.save(new CertificationPath(newestCertificate, []), subjectPrivateAddress);

    await expect(
      store.retrieveLatest(subjectPrivateAddress, subjectPrivateAddress),
    ).resolves.toSatisfy((p) => newestCertificate.isEqual(p.leafCertificate));
  });
});

describe('retrieveAllSerializations', () => {
  test('Nothing should be returned if there are no certificates', async () => {
    await expect(
      store.retrieveAll(subjectPrivateAddress, subjectPrivateAddress),
    ).resolves.toBeEmpty();
  });

  test('Expired certificates should not be returned', async () => {
    await store.save(expiredCertificationPath, subjectPrivateAddress);

    await expect(
      store.retrieveAll(subjectPrivateAddress, subjectPrivateAddress),
    ).resolves.toBeEmpty();
  });

  test('All valid certificates should be returned', async () => {
    await store.save(expiredCertificationPath, subjectPrivateAddress);
    await store.save(validCertificationPath, subjectPrivateAddress);
    const newestCertificate = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: addSeconds(validCertificate.expiryDate, 1),
    });
    await store.save(new CertificationPath(newestCertificate, []), subjectPrivateAddress);

    const allCertificates = await store.retrieveAll(subjectPrivateAddress, subjectPrivateAddress);

    expect(allCertificates).toHaveLength(2);
    expect(
      allCertificates.filter((p) => p.leafCertificate.isEqual(validCertificate)),
    ).not.toBeEmpty();
    expect(
      allCertificates.filter((p) => p.leafCertificate.isEqual(newestCertificate)),
    ).not.toBeEmpty();
  });

  test('Scope should be temporarily stored', async () => {
    await store.save(validCertificationPath, subjectPrivateAddress);

    const allCertificates = await store.retrieveAll(subjectPrivateAddress, subjectPrivateAddress);

    expect(allCertificates).toHaveLength(1);
    expect(allCertificates[0].leafCertificate.isEqual(validCertificate)).toBeTrue();
  });
});

describe('deleteExpired', () => {
  test('Valid certificates should not be deleted', async () => {
    await store.save(validCertificationPath, subjectPrivateAddress);

    await store.deleteExpired();

    await expect(
      store.retrieveAll(subjectPrivateAddress, subjectPrivateAddress),
    ).resolves.toHaveLength(1);
  });
});
