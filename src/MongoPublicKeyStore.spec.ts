// tslint:disable:no-object-mutation

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

import { mockSpy } from './_test_utils';
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
const mockFindOneExec = mockSpy(jest.fn(), async () => PEER_PUBLIC_KEY_DATA);
const mockFindOne = mockSpy(jest.fn(), () => ({ exec: mockFindOneExec }));

describe('fetchKey', () => {
  beforeEach(() => stubGetModelForClass.mockReturnValue({ findOne: mockFindOne } as any));

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

    expect(mockFindOne).toBeCalledTimes(1);
    expect(mockFindOne).toBeCalledWith({
      peerPrivateAddress: await PEER_CERTIFICATE.calculateSubjectPrivateAddress(),
    });
  });

  test('Existing key should be returned', async () => {
    const store = new MongoPublicKeyStore(STUB_CONNECTION);

    const key = await store.fetchLastSessionKey(PEER_CERTIFICATE);

    expect(key?.keyId).toEqual(PEER_PUBLIC_KEY_DATA.keyId);
    expect(await derSerializePublicKey(key!.publicKey)).toEqual(PEER_PUBLIC_KEY_DATA.keyDer);
  });

  test('Non-existing key should result in null', async () => {
    const store = new MongoPublicKeyStore(STUB_CONNECTION);
    mockFindOneExec.mockResolvedValue(null);

    await expect(store.fetchLastSessionKey(PEER_CERTIFICATE)).resolves.toBeNull();
  });
});

describe('saveKey', () => {
  const mockUpdateOne = mockSpy(jest.fn(), () => ({ exec: jest.fn() }));
  beforeEach(() =>
    stubGetModelForClass.mockReturnValue({ findOne: mockFindOne, updateOne: mockUpdateOne } as any),
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
    const creationDate = new Date();

    await store.saveSessionKey(PEER_SESSION_KEY, PEER_CERTIFICATE, creationDate);

    expect(mockUpdateOne).toBeCalledTimes(1);
    expect(mockUpdateOne).toBeCalledWith(
      { peerPrivateAddress: await PEER_CERTIFICATE.calculateSubjectPrivateAddress() },
      { ...PEER_PUBLIC_KEY_DATA, creationDate },
      { upsert: true },
    );
  });
});
