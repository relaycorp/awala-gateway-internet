// tslint:disable:no-let no-object-mutation

import {
  Certificate,
  derSerializePublicKey,
  generateECDHKeyPair,
  generateRSAKeyPair,
  issueGatewayCertificate,
  OriginatorSessionKey,
} from '@relaycorp/relaynet-core';
import * as typegoose from '@typegoose/typegoose';
import { Connection } from 'mongoose';

import { mockSpy } from '../_test_utils';
import { PeerPublicKeyData } from './models';
import { MongoPublicKeyStore } from './MongoPublicKeyStore';

const STUB_CONNECTION: Connection = { what: 'the-stub-connection' } as any;

let PEER_CERTIFICATE: Certificate;
let PEER_PUBLIC_KEY_DATA: PeerPublicKeyData;
let PEER_PUBLIC_KEY: CryptoKey;
beforeAll(async () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  const keyPair = await generateRSAKeyPair();
  PEER_CERTIFICATE = await issueGatewayCertificate({
    issuerPrivateKey: keyPair.privateKey,
    subjectPublicKey: keyPair.publicKey,
    validityEndDate: tomorrow,
  });

  const sessionKeyPair = await generateECDHKeyPair();
  PEER_PUBLIC_KEY = sessionKeyPair.publicKey;

  PEER_PUBLIC_KEY_DATA = new PeerPublicKeyData();
  PEER_PUBLIC_KEY_DATA.peerPrivateAddress = await PEER_CERTIFICATE.calculateSubjectPrivateAddress();
  PEER_PUBLIC_KEY_DATA.keyId = Buffer.from([1, 3, 5, 7]);
  PEER_PUBLIC_KEY_DATA.keyDer = await derSerializePublicKey(sessionKeyPair.publicKey);
  PEER_PUBLIC_KEY_DATA.creationDate = new Date();
});

const stubGetModelForClass = mockSpy(jest.spyOn(typegoose, 'getModelForClass'));

describe('fetchKey', () => {
  const stubModelExec = mockSpy(jest.fn(), async () => PEER_PUBLIC_KEY_DATA);
  const stubFindOne = mockSpy(jest.fn(), () => ({ exec: stubModelExec }));
  beforeEach(() => stubGetModelForClass.mockReturnValue({ findOne: stubFindOne } as any));

  test('Existing connection should be used', async () => {
    const store = new MongoPublicKeyStore(STUB_CONNECTION);

    await store.fetchLastSessionKey(PEER_CERTIFICATE);

    expect(stubGetModelForClass).toBeCalledTimes(1);
    expect(stubGetModelForClass).toBeCalledWith(PeerPublicKeyData, {
      existingConnection: STUB_CONNECTION,
    });
  });

  test('Key should be looked up by the private node address of the peer', async () => {
    const store = new MongoPublicKeyStore(STUB_CONNECTION);

    await store.fetchLastSessionKey(PEER_CERTIFICATE);

    expect(stubFindOne).toBeCalledTimes(1);
    expect(stubFindOne).toBeCalledWith({
      peerPrivateAddress: await PEER_CERTIFICATE.calculateSubjectPrivateAddress(),
    });
  });

  test('Existing key should be returned', async () => {
    const store = new MongoPublicKeyStore(STUB_CONNECTION);

    const key = await store.fetchLastSessionKey(PEER_CERTIFICATE);

    expect(key.keyId).toEqual(PEER_PUBLIC_KEY_DATA.keyId);
    expect(await derSerializePublicKey(key.publicKey)).toEqual(PEER_PUBLIC_KEY_DATA.keyDer);
  });

  test('Non-existing key should result in an error', async () => {
    const store = new MongoPublicKeyStore(STUB_CONNECTION);
    stubModelExec.mockResolvedValue(null);

    await expect(store.fetchLastSessionKey(PEER_CERTIFICATE)).rejects.toMatchObject({
      message: expect.stringMatching(/Key could not be found/),
    });
  });
});

describe('saveKey', () => {
  const stubModelExec = mockSpy(jest.fn());
  const stubFindOneAndUpdate = mockSpy(jest.fn(), () => ({ exec: stubModelExec }));
  beforeEach(() =>
    stubGetModelForClass.mockReturnValue({ updateOne: stubFindOneAndUpdate } as any),
  );

  let PEER_SESSION_KEY: OriginatorSessionKey;
  beforeAll(() => {
    PEER_SESSION_KEY = { keyId: PEER_PUBLIC_KEY_DATA.keyId, publicKey: PEER_PUBLIC_KEY };
  });

  test('Existing connection should be used', async () => {
    const store = new MongoPublicKeyStore(STUB_CONNECTION);

    await store.saveSessionKey(PEER_SESSION_KEY, PEER_CERTIFICATE, new Date());

    expect(stubGetModelForClass).toBeCalledTimes(1);
    expect(stubGetModelForClass).toBeCalledWith(PeerPublicKeyData, {
      existingConnection: STUB_CONNECTION,
    });
  });

  test('Key should be upserted', async () => {
    const store = new MongoPublicKeyStore(STUB_CONNECTION);

    await store.saveSessionKey(
      PEER_SESSION_KEY,
      PEER_CERTIFICATE,
      PEER_PUBLIC_KEY_DATA.creationDate,
    );

    expect(stubFindOneAndUpdate).toBeCalledTimes(1);
    expect(stubFindOneAndUpdate).toBeCalledWith(
      { peerPrivateAddress: await PEER_CERTIFICATE.calculateSubjectPrivateAddress() },
      PEER_PUBLIC_KEY_DATA,
      { upsert: true },
    );
  });
});
