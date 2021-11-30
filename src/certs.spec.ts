import { Certificate, generateRSAKeyPair, issueGatewayCertificate } from '@relaycorp/relaynet-core';
import { addMinutes } from 'date-fns';

import { setUpTestDBConnection } from './_test_utils';
import { retrieveOwnCertificates } from './certs';
import { MongoCertificateStore } from './keystores/MongoCertificateStore';
import { Config, ConfigKey } from './utilities/config';

const getMongooseConnection = setUpTestDBConnection();

let certificate1: Certificate;
let certificate2: Certificate;
beforeAll(async () => {
  const identityKeyPair = await generateRSAKeyPair();
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

let certificateStore: MongoCertificateStore;
beforeEach(async () => {
  const connection = getMongooseConnection();

  certificateStore = new MongoCertificateStore(connection);

  const config = new Config(connection);
  await config.set(
    ConfigKey.CURRENT_PRIVATE_ADDRESS,
    await certificate1.calculateSubjectPrivateAddress(),
  );
});

describe('retrieveOwnCertificates', () => {
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

  test('Multiple certificates should be retuned when there are multiple certificates', async () => {
    await certificateStore.save(certificate1);
    await certificateStore.save(certificate2);

    const certs = await retrieveOwnCertificates(getMongooseConnection());

    expect(certs).toHaveLength(2);
    expect(certs.filter((c) => certificate1.isEqual(c))).toHaveLength(1);
    expect(certs.filter((c) => certificate2.isEqual(c))).toHaveLength(1);
  });
});
