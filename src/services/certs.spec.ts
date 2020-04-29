/* tslint:disable:no-let no-object-mutation */

import { generateRSAKeyPair } from '@relaycorp/relaynet-core';
import * as typegoose from '@typegoose/typegoose';
import bufferToArray from 'buffer-to-arraybuffer';
import { Connection } from 'mongoose';

import { mockSpy } from '../_test_utils';
import { expectBuffersToEqual, generateStubEndpointCertificate } from './_test_utils';
import { retrieveOwnCertificates } from './certs';
import { OwnCertificate } from './models';

const stubConnection: Connection = { whoAreYou: 'the-stub-connection' } as any;

const stubModelExec = mockSpy(jest.fn(), async () => []);
const stubFind = mockSpy(jest.fn(), () => ({ exec: stubModelExec }));
const stubGetModelForClass = mockSpy(jest.spyOn(typegoose, 'getModelForClass'), () => ({
  find: stubFind,
}));

let stubOwnCerts: readonly OwnCertificate[];
beforeAll(async () => {
  const keyPair1 = await generateRSAKeyPair();
  const ownCert1 = new OwnCertificate();
  ownCert1.serializationDer = Buffer.from(
    (await generateStubEndpointCertificate(keyPair1)).serialize(),
  );

  const keyPair2 = await generateRSAKeyPair();
  const ownCert2 = new OwnCertificate();
  ownCert2.serializationDer = Buffer.from(
    (await generateStubEndpointCertificate(keyPair2)).serialize(),
  );

  stubOwnCerts = [ownCert1, ownCert2];
});

describe('retrieveOwnCertificates', () => {
  test('The specified connection should be used', async () => {
    await retrieveOwnCertificates(stubConnection);

    expect(stubGetModelForClass).toBeCalledTimes(1);
    expect(stubGetModelForClass).toBeCalledWith(OwnCertificate, {
      existingConnection: stubConnection,
    });
  });

  test('All records should be queried', async () => {
    await retrieveOwnCertificates(stubConnection);

    expect(stubFind).toBeCalledTimes(1);
    expect(stubFind).toBeCalledWith({});
  });

  test('An empty array should be returned when there are no certificates', async () => {
    const certs = await retrieveOwnCertificates(stubConnection);

    expect(certs).toEqual([]);
  });

  test('A single certificate should be returned when there is one certificate', async () => {
    stubModelExec.mockReset();
    stubModelExec.mockResolvedValueOnce([stubOwnCerts[0]]);

    const certs = await retrieveOwnCertificates(stubConnection);

    expect(certs).toHaveLength(1);
    expectBuffersToEqual(certs[0].serialize(), bufferToArray(stubOwnCerts[0].serializationDer));
  });

  test('Multiple certificates should be retuned when there are multiple certificates', async () => {
    stubModelExec.mockReset();
    stubModelExec.mockResolvedValueOnce(stubOwnCerts);

    const certs = await retrieveOwnCertificates(stubConnection);

    expect(certs).toHaveLength(stubOwnCerts.length);
    for (let i = 0; i < stubOwnCerts.length; i++) {
      expectBuffersToEqual(certs[i].serialize(), bufferToArray(stubOwnCerts[i].serializationDer));
    }
  });
});
