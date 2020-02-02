/* tslint:disable:no-let */

import { generateRSAKeyPair } from '@relaycorp/relaynet-core';
import * as typegoose from '@typegoose/typegoose';
import bufferToArray from 'buffer-to-arraybuffer';
import { Connection } from 'mongoose';

import { expectBuffersToEqual, generateStubEndpointCertificate } from './_test_utils';
import { retrieveOwnCertificates } from './certs';
import { OwnCertificate } from './models';

// @ts-ignore
const stubConnection: Connection = { whoAreYou: 'the-stub-connection' };

const mockGetModelForClass = jest.spyOn(typegoose, 'getModelForClass');
const mockModelExec = jest.fn().mockResolvedValue([]);
const mockFind = jest.fn(() => {
  return { exec: mockModelExec };
});
beforeEach(() => {
  mockModelExec.mockClear();
  mockFind.mockClear();

  mockGetModelForClass.mockReset();
  mockGetModelForClass.mockReturnValue({ find: mockFind });
});
afterAll(() => mockGetModelForClass.mockRestore());

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

    expect(mockGetModelForClass).toBeCalledTimes(1);
    expect(mockGetModelForClass).toBeCalledWith(OwnCertificate, {
      existingConnection: stubConnection,
    });
  });

  test('All records should be queried', async () => {
    await retrieveOwnCertificates(stubConnection);

    expect(mockFind).toBeCalledTimes(1);
    expect(mockFind).toBeCalledWith({});
  });

  test('An empty array should be returned when there are no certificates', async () => {
    const certs = await retrieveOwnCertificates(stubConnection);

    expect(certs).toEqual([]);
  });

  test('A single certificate should be returned when there is one certificate', async () => {
    mockModelExec.mockReset();
    mockModelExec.mockResolvedValueOnce([stubOwnCerts[0]]);

    const certs = await retrieveOwnCertificates(stubConnection);

    expect(certs).toHaveLength(1);
    expectBuffersToEqual(certs[0].serialize(), bufferToArray(stubOwnCerts[0].serializationDer));
  });

  test('Multiple certificates should be retuned when there are multiple certificates', async () => {
    mockModelExec.mockReset();
    mockModelExec.mockResolvedValueOnce(stubOwnCerts);

    const certs = await retrieveOwnCertificates(stubConnection);

    expect(certs).toHaveLength(stubOwnCerts.length);
    for (let i = 0; i < stubOwnCerts.length; i++) {
      expectBuffersToEqual(certs[i].serialize(), bufferToArray(stubOwnCerts[i].serializationDer));
    }
  });
});
