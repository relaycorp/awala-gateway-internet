import {
  Certificate,
  CertificateScope,
  generateRSAKeyPair,
  getPrivateAddressFromIdentityKey,
  issueGatewayCertificate,
} from '@relaycorp/relaynet-core';
import { getModelForClass, ReturnModelType } from '@typegoose/typegoose';
import { addDays, addSeconds, subSeconds } from 'date-fns';

import { Certificate as CertificateModel } from '../models';
import { setUpTestDBConnection } from '../testUtils/db';
import { MongoCertificateStore } from './MongoCertificateStore';

const getConnection = setUpTestDBConnection();
let certificateModel: ReturnModelType<typeof CertificateModel>;
let store: MongoCertificateStore;
beforeAll(async () => {
  const connection = getConnection();
  certificateModel = getModelForClass(CertificateModel, { existingConnection: connection });
  store = new MongoCertificateStore(connection);
});

let identityKeyPair: CryptoKeyPair;
let subjectPrivateAddress: string;
let validCertificate: Certificate;
let expiredCertificate: Certificate;
beforeAll(async () => {
  identityKeyPair = await generateRSAKeyPair();
  subjectPrivateAddress = await getPrivateAddressFromIdentityKey(identityKeyPair.publicKey);

  validCertificate = await issueGatewayCertificate({
    issuerPrivateKey: identityKeyPair.privateKey,
    subjectPublicKey: identityKeyPair.publicKey,
    validityEndDate: addSeconds(new Date(), 15),
  });
  expiredCertificate = await issueGatewayCertificate({
    issuerPrivateKey: identityKeyPair.privateKey,
    subjectPublicKey: identityKeyPair.publicKey,
    validityEndDate: subSeconds(new Date(), 1),
    validityStartDate: subSeconds(new Date(), 2),
  });
});

describe('saveData', () => {
  test('All attributes should be saved', async () => {
    await store.save(validCertificate, CertificateScope.PDA);

    const certificateStored = await certificateModel.findOne({ subjectPrivateAddress }).exec();
    expect(certificateStored).toMatchObject<Partial<CertificateModel>>({
      certificateSerialized: Buffer.from(validCertificate.serialize()),
      expiryDate: validCertificate.expiryDate,
      scope: CertificateScope.PDA,
    });
  });

  test('The same subject should be allowed to have multiple certificates', async () => {
    const certificate2 = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: addDays(validCertificate.expiryDate, 1),
    });

    await store.save(validCertificate, CertificateScope.PDA);
    await store.save(certificate2, CertificateScope.PDA);

    const certificateRecords = await certificateModel.find({ subjectPrivateAddress }).exec();
    expect(certificateRecords).toHaveLength(2);
    expect(certificateRecords[0]).toMatchObject<Partial<CertificateModel>>({
      certificateSerialized: Buffer.from(validCertificate.serialize()),
      expiryDate: validCertificate.expiryDate,
    });
    expect(certificateRecords[1]).toMatchObject<Partial<CertificateModel>>({
      certificateSerialized: Buffer.from(certificate2.serialize()),
      expiryDate: certificate2.expiryDate,
    });
  });

  test('Certificates with the same subject and expiry should be deduped within same scope', async () => {
    const certificate2 = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: validCertificate.expiryDate,
    });

    await store.save(validCertificate, CertificateScope.PDA);
    await store.save(certificate2, CertificateScope.PDA);

    const certificateRecords = await certificateModel.find({ subjectPrivateAddress }).exec();
    expect(certificateRecords).toHaveLength(1);
    expect(certificateRecords[0]).toMatchObject<Partial<CertificateModel>>({
      certificateSerialized: Buffer.from(certificate2.serialize()),
      expiryDate: certificate2.expiryDate,
    });
  });

  test('Certificates with the same subject and expiry should not be deduped across scopes', async () => {
    const certificate2 = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: validCertificate.expiryDate,
    });

    await store.save(validCertificate, CertificateScope.CDA);
    await store.save(certificate2, CertificateScope.PDA);

    await expect(
      certificateModel.find({ subjectPrivateAddress, scope: CertificateScope.CDA }).exec(),
    ).resolves.toHaveLength(1);
    await expect(
      certificateModel.find({ subjectPrivateAddress, scope: CertificateScope.PDA }).exec(),
    ).resolves.toHaveLength(1);
  });
});

describe('retrieveLatestSerialization', () => {
  test('Nothing should be returned if subject has no certificates', async () => {
    await expect(
      store.retrieveLatest(subjectPrivateAddress, CertificateScope.PDA),
    ).resolves.toBeNull();
  });

  test('Expired certificates should not be returned', async () => {
    await store.save(expiredCertificate, CertificateScope.PDA);

    await expect(
      store.retrieveLatest(subjectPrivateAddress, CertificateScope.PDA),
    ).resolves.toBeNull();
  });

  test('The latest valid certificate should be returned', async () => {
    await store.save(validCertificate, CertificateScope.PDA);
    const newestCertificate = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: addSeconds(validCertificate.expiryDate, 1),
    });
    await store.save(newestCertificate, CertificateScope.PDA);

    await expect(
      store.retrieveLatest(subjectPrivateAddress, CertificateScope.PDA),
    ).resolves.toSatisfy((c) => newestCertificate.isEqual(c));
  });

  test('Scope should be temporarily ignored', async () => {
    await store.save(validCertificate, CertificateScope.CDA);

    const latestCertificate = await store.retrieveLatest(
      subjectPrivateAddress,
      CertificateScope.PDA,
    );

    expect(latestCertificate!.isEqual(validCertificate)).toBeTrue();
  });
});

describe('retrieveAllSerializations', () => {
  test('Nothing should be returned if there are no certificates', async () => {
    await expect(
      store.retrieveAll(subjectPrivateAddress, CertificateScope.PDA),
    ).resolves.toBeEmpty();
  });

  test('Expired certificates should not be returned', async () => {
    await store.save(expiredCertificate, CertificateScope.PDA);

    await expect(
      store.retrieveAll(subjectPrivateAddress, CertificateScope.PDA),
    ).resolves.toBeEmpty();
  });

  test('All valid certificates should be returned', async () => {
    await store.save(expiredCertificate, CertificateScope.PDA);
    await store.save(validCertificate, CertificateScope.PDA);
    const newestCertificate = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: addSeconds(validCertificate.expiryDate, 1),
    });
    await store.save(newestCertificate, CertificateScope.PDA);

    const allCertificates = await store.retrieveAll(subjectPrivateAddress, CertificateScope.PDA);

    expect(allCertificates).toHaveLength(2);
    expect(allCertificates.filter((c) => c.isEqual(validCertificate))).not.toBeEmpty();
    expect(allCertificates.filter((c) => c.isEqual(newestCertificate))).not.toBeEmpty();
  });

  test('Scope should be temporarily stored', async () => {
    await store.save(validCertificate, CertificateScope.CDA);

    const allCertificates = await store.retrieveAll(subjectPrivateAddress, CertificateScope.PDA);

    expect(allCertificates).toHaveLength(1);
    expect(allCertificates[0].isEqual(validCertificate)).toBeTrue();
  });
});

describe('deleteExpired', () => {
  test('Valid certificates should not be deleted', async () => {
    await store.save(validCertificate, CertificateScope.PDA);

    await store.deleteExpired();

    await expect(
      store.retrieveAll(subjectPrivateAddress, CertificateScope.PDA),
    ).resolves.toHaveLength(1);
  });
});
