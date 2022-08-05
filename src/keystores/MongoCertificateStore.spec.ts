import {
  Certificate,
  CertificationPath,
  generateRSAKeyPair,
  getIdFromIdentityKey,
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
let subjectId: string;
let validCertificate: Certificate;
let validCertificationPath: CertificationPath;
let expiredCertificate: Certificate;
let expiredCertificationPath: CertificationPath;
beforeAll(async () => {
  identityKeyPair = await generateRSAKeyPair();
  subjectId = await getIdFromIdentityKey(identityKeyPair.publicKey);

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
    await store.save(validCertificationPath, subjectId);

    const certificateStored = await certificateModel.findOne({ subjectId }).exec();
    expect(certificateStored?.expiryDate).toEqual(validCertificate.expiryDate);
    expect(certificateStored?.issuerId).toEqual(subjectId);
    expect(Buffer.from(certificateStored!.pathSerialized)).toEqual(
      Buffer.from(validCertificationPath.serialize()),
    );
  });

  test('The same subject should be allowed to have multiple certificates', async () => {
    const certificate2 = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: addDays(validCertificate.expiryDate, 1),
    });
    const certificationPath2 = new CertificationPath(certificate2, []);

    await store.save(validCertificationPath, subjectId);
    await store.save(certificationPath2, subjectId);

    const certificateRecords = await certificateModel.find({ subjectId }).exec();
    expect(certificateRecords).toHaveLength(2);
    expect(certificateRecords[0]?.expiryDate).toEqual(validCertificate.expiryDate);
    expect(Buffer.from(certificateRecords[0]!.pathSerialized)).toEqual(
      Buffer.from(validCertificationPath.serialize()),
    );
    expect(certificateRecords[1]?.expiryDate).toEqual(certificate2.expiryDate);
    expect(Buffer.from(certificateRecords[1]!.pathSerialized)).toEqual(
      Buffer.from(certificationPath2.serialize()),
    );
  });

  test('Certificates with the same subject and expiry should be deduped within same scope', async () => {
    const certificate2 = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: validCertificate.expiryDate,
    });
    const certificationPath2 = new CertificationPath(certificate2, []);

    await store.save(validCertificationPath, subjectId);
    await store.save(certificationPath2, subjectId);

    const certificateRecords = await certificateModel.find({ subjectId }).exec();
    expect(certificateRecords).toHaveLength(1);
    expect(certificateRecords[0]?.expiryDate).toEqual(certificate2.expiryDate);
    expect(Buffer.from(certificateRecords[0]!.pathSerialized)).toEqual(
      Buffer.from(certificationPath2.serialize()),
    );
  });

  test('Certificates with the same subject and expiry should not be deduped across scopes', async () => {
    const certificate2 = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: validCertificate.expiryDate,
    });

    await store.save(validCertificationPath, subjectId);
    await store.save(new CertificationPath(certificate2, []), subjectId);

    await expect(
      certificateModel.find({ subjectId, issuerId: subjectId }).exec(),
    ).resolves.toHaveLength(1);
    await expect(
      certificateModel.find({ subjectId, issuerId: subjectId }).exec(),
    ).resolves.toHaveLength(1);
  });
});

describe('retrieveLatestSerialization', () => {
  test('Nothing should be returned if subject has no certificates', async () => {
    await expect(store.retrieveLatest(subjectId, subjectId)).resolves.toBeNull();
  });

  test('Expired certificates should not be returned', async () => {
    await store.save(expiredCertificationPath, subjectId);

    await expect(store.retrieveLatest(subjectId, subjectId)).resolves.toBeNull();
  });

  test('The latest valid certificate should be returned', async () => {
    await store.save(validCertificationPath, subjectId);
    const newestCertificate = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: addSeconds(validCertificate.expiryDate, 1),
    });
    await store.save(new CertificationPath(newestCertificate, []), subjectId);

    await expect(store.retrieveLatest(subjectId, subjectId)).resolves.toSatisfy((p) =>
      newestCertificate.isEqual(p.leafCertificate),
    );
  });
});

describe('retrieveAllSerializations', () => {
  test('Nothing should be returned if there are no certificates', async () => {
    await expect(store.retrieveAll(subjectId, subjectId)).resolves.toBeEmpty();
  });

  test('Expired certificates should not be returned', async () => {
    await store.save(expiredCertificationPath, subjectId);

    await expect(store.retrieveAll(subjectId, subjectId)).resolves.toBeEmpty();
  });

  test('All valid certificates should be returned', async () => {
    await store.save(expiredCertificationPath, subjectId);
    await store.save(validCertificationPath, subjectId);
    const newestCertificate = await issueGatewayCertificate({
      issuerPrivateKey: identityKeyPair.privateKey,
      subjectPublicKey: identityKeyPair.publicKey,
      validityEndDate: addSeconds(validCertificate.expiryDate, 1),
    });
    await store.save(new CertificationPath(newestCertificate, []), subjectId);

    const allCertificates = await store.retrieveAll(subjectId, subjectId);

    expect(allCertificates).toHaveLength(2);
    expect(
      allCertificates.filter((p) => p.leafCertificate.isEqual(validCertificate)),
    ).not.toBeEmpty();
    expect(
      allCertificates.filter((p) => p.leafCertificate.isEqual(newestCertificate)),
    ).not.toBeEmpty();
  });

  test('Scope should be temporarily stored', async () => {
    await store.save(validCertificationPath, subjectId);

    const allCertificates = await store.retrieveAll(subjectId, subjectId);

    expect(allCertificates).toHaveLength(1);
    expect(allCertificates[0].leafCertificate.isEqual(validCertificate)).toBeTrue();
  });
});

describe('deleteExpired', () => {
  test('Valid certificates should not be deleted', async () => {
    await store.save(validCertificationPath, subjectId);

    await store.deleteExpired();

    await expect(store.retrieveAll(subjectId, subjectId)).resolves.toHaveLength(1);
  });
});
