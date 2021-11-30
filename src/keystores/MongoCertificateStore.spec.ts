import {
  Certificate,
  generateRSAKeyPair,
  getPrivateAddressFromIdentityKey,
  issueGatewayCertificate,
} from '@relaycorp/relaynet-core';
import { getModelForClass, ReturnModelType } from '@typegoose/typegoose';
import { addDays, addSeconds, subSeconds } from 'date-fns';

import { setUpTestDBConnection } from '../_test_utils';
import { Certificate as CertificateModel } from '../models';
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
    await store.save(validCertificate);

    const certificateStored = await certificateModel.findOne({ subjectPrivateAddress }).exec();
    expect(certificateStored).toMatchObject<Partial<CertificateModel>>({
      certificateSerialized: Buffer.from(validCertificate.serialize()),
      expiryDate: validCertificate.expiryDate,
    });
  });

  test('The same subject should be allowed to have multiple certificates', async () => {
    const certificate2 = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: addDays(validCertificate.expiryDate, 1),
    });

    await store.save(validCertificate);
    await store.save(certificate2);

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

  test('Certificates with the same subject and expiry date should be deduped', async () => {
    const certificate2 = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: validCertificate.expiryDate,
    });

    await store.save(validCertificate);
    await store.save(certificate2);

    const certificateRecords = await certificateModel.find({ subjectPrivateAddress }).exec();
    expect(certificateRecords).toHaveLength(1);
    expect(certificateRecords[0]).toMatchObject<Partial<CertificateModel>>({
      certificateSerialized: Buffer.from(certificate2.serialize()),
      expiryDate: certificate2.expiryDate,
    });
  });
});

describe('retrieveLatestSerialization', () => {
  test('Nothing should be returned if subject has no certificates', async () => {
    await expect(store.retrieveLatest(subjectPrivateAddress)).resolves.toBeNull();
  });

  test('Expired certificates should not be returned', async () => {
    await store.save(expiredCertificate);

    await expect(store.retrieveLatest(subjectPrivateAddress)).resolves.toBeNull();
  });

  test('The latest valid certificate should be returned', async () => {
    await store.save(validCertificate);
    const newestCertificate = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: addSeconds(validCertificate.expiryDate, 1),
    });
    await store.save(newestCertificate);

    await expect(store.retrieveLatest(subjectPrivateAddress)).resolves.toSatisfy((c) =>
      newestCertificate.isEqual(c),
    );
  });
});

describe('retrieveAllSerializations', () => {
  test('Nothing should be returned if there are no certificates', async () => {
    await expect(store.retrieveAll(subjectPrivateAddress)).resolves.toBeEmpty();
  });

  test('Expired certificates should not be returned', async () => {
    await store.save(expiredCertificate);

    await expect(store.retrieveAll(subjectPrivateAddress)).resolves.toBeEmpty();
  });

  test('All valid certificates should be returned', async () => {
    await store.save(expiredCertificate);
    await store.save(validCertificate);
    const newestCertificate = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: addSeconds(validCertificate.expiryDate, 1),
    });
    await store.save(newestCertificate);

    const allCertificates = await store.retrieveAll(subjectPrivateAddress);

    expect(allCertificates).toHaveLength(2);
    expect(allCertificates.filter((c) => c.isEqual(validCertificate))).not.toBeEmpty();
    expect(allCertificates.filter((c) => c.isEqual(newestCertificate))).not.toBeEmpty();
  });
});

describe('deleteExpired', () => {
  test('Valid certificates should not be deleted', async () => {
    await store.save(validCertificate);

    await store.deleteExpired();

    await expect(store.retrieveAll(subjectPrivateAddress)).resolves.toHaveLength(1);
  });
});
