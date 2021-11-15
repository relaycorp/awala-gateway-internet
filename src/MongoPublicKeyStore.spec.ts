// tslint:disable:no-object-mutation

import {
  derSerializePublicKey,
  generateECDHKeyPair,
  generateRSAKeyPair,
  getPrivateAddressFromIdentityKey,
  SessionKey,
} from '@relaycorp/relaynet-core';
import * as typegoose from '@typegoose/typegoose';
import { Connection } from 'mongoose';

import { mockSpy } from './_test_utils';
import { PeerPublicKeyData } from './models';
import { MongoPublicKeyStore } from './MongoPublicKeyStore';

const STUB_CONNECTION: Connection = { what: 'the-stub-connection' } as any;

let peerPublicKeyData: PeerPublicKeyData;
let peerPublicKey: CryptoKey;
let peerPrivateAddress: string;
beforeAll(async () => {
  const keyPair = await generateRSAKeyPair();
  peerPrivateAddress = await getPrivateAddressFromIdentityKey(keyPair.publicKey);

  const sessionKeyPair = await generateECDHKeyPair();
  peerPublicKey = sessionKeyPair.publicKey;

  peerPublicKeyData = new PeerPublicKeyData();
  peerPublicKeyData.peerPrivateAddress = peerPrivateAddress;
  peerPublicKeyData.keyId = Buffer.from([1, 3, 5, 7]);
  peerPublicKeyData.keyDer = await derSerializePublicKey(sessionKeyPair.publicKey);
  peerPublicKeyData.creationDate = new Date();
});

const stubGetModelForClass = mockSpy(jest.spyOn(typegoose, 'getModelForClass'));
const mockFindOneExec = mockSpy(jest.fn(), async () => peerPublicKeyData);
const mockFindOne = mockSpy(jest.fn(), () => ({ exec: mockFindOneExec }));

describe('fetchKey', () => {
  beforeEach(() => stubGetModelForClass.mockReturnValue({ findOne: mockFindOne } as any));

  test('Existing connection should be used', async () => {
    const store = new MongoPublicKeyStore(STUB_CONNECTION);

    await store.fetchLastSessionKey(peerPrivateAddress);

    expect(stubGetModelForClass).toBeCalledTimes(1);
    expect(stubGetModelForClass).toBeCalledWith(PeerPublicKeyData, {
      existingConnection: STUB_CONNECTION,
    });
  });

  test('Key should be looked up by the private node address of the peer', async () => {
    const store = new MongoPublicKeyStore(STUB_CONNECTION);

    await store.fetchLastSessionKey(peerPrivateAddress);

    expect(mockFindOne).toBeCalledTimes(1);
    expect(mockFindOne).toBeCalledWith({ peerPrivateAddress });
  });

  test('Existing key should be returned', async () => {
    const store = new MongoPublicKeyStore(STUB_CONNECTION);

    const key = await store.fetchLastSessionKey(peerPrivateAddress);

    expect(key?.keyId).toEqual(peerPublicKeyData.keyId);
    expect(await derSerializePublicKey(key!.publicKey)).toEqual(peerPublicKeyData.keyDer);
  });

  test('Non-existing key should result in null', async () => {
    const store = new MongoPublicKeyStore(STUB_CONNECTION);
    mockFindOneExec.mockResolvedValue(null);

    await expect(store.fetchLastSessionKey(peerPrivateAddress)).resolves.toBeNull();
  });
});

describe('saveKey', () => {
  const mockUpdateOne = mockSpy(jest.fn(), () => ({ exec: jest.fn() }));
  beforeEach(() =>
    stubGetModelForClass.mockReturnValue({ findOne: mockFindOne, updateOne: mockUpdateOne } as any),
  );

  let PEER_SESSION_KEY: SessionKey;
  beforeAll(() => {
    PEER_SESSION_KEY = { keyId: peerPublicKeyData.keyId, publicKey: peerPublicKey };
  });

  test('Existing connection should be used', async () => {
    const store = new MongoPublicKeyStore(STUB_CONNECTION);

    await store.saveSessionKey(PEER_SESSION_KEY, peerPrivateAddress, new Date());

    expect(stubGetModelForClass).toBeCalledTimes(1);
    expect(stubGetModelForClass).toBeCalledWith(PeerPublicKeyData, {
      existingConnection: STUB_CONNECTION,
    });
  });

  test('Key should be upserted', async () => {
    const store = new MongoPublicKeyStore(STUB_CONNECTION);
    const creationDate = new Date();

    await store.saveSessionKey(PEER_SESSION_KEY, peerPrivateAddress, creationDate);

    expect(mockUpdateOne).toBeCalledTimes(1);
    expect(mockUpdateOne).toBeCalledWith(
      { peerPrivateAddress },
      { ...peerPublicKeyData, creationDate },
      { upsert: true },
    );
  });
});
