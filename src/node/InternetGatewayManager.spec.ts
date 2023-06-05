import { KeyStoreSet, MockKeyStoreSet } from '@relaycorp/relaynet-core';
import { MongoCertificateStore, MongoPublicKeyStore } from '@relaycorp/awala-keystore-mongodb';

import * as vault from '../backingServices/keystore';
import { InternetGatewayError } from '../errors';
import { setUpTestDBConnection } from '../testUtils/db';
import { mockSpy } from '../testUtils/jest';
import { Config, ConfigKey } from '../utilities/config';
import { InternetGatewayManager } from './InternetGatewayManager';

jest.mock('@relaycorp/awala-keystore-mongodb');

const getMongoConnection = setUpTestDBConnection();

const keyStoreSet = new MockKeyStoreSet();
beforeEach(() => {
  keyStoreSet.clear();
});

describe('init', () => {
  mockSpy(jest.spyOn(vault, 'initPrivateKeyStore'), () => keyStoreSet.privateKeyStore);

  test('Manager should be output', async () => {
    await expect(InternetGatewayManager.init(getMongoConnection())).resolves.toBeInstanceOf(
      InternetGatewayManager,
    );
  });

  test('Key stores should be used', async () => {
    const manager = await InternetGatewayManager.init(getMongoConnection());

    // We can't simply read some attributes on the manager, so we have to actually use the stores
    const { id } = await keyStoreSet.privateKeyStore.generateIdentityKeyPair();
    const gatewayConstructorSpy = jest.fn();
    await manager.get(id, gatewayConstructorSpy);
    // tslint:disable-next-line:readonly-array
    expect(gatewayConstructorSpy).toBeCalledWith<[any, any, KeyStoreSet, any]>(
      expect.anything(),
      expect.anything(),
      {
        certificateStore: expect.any(MongoCertificateStore),
        privateKeyStore: keyStoreSet.privateKeyStore,
        publicKeyStore: expect.any(MongoPublicKeyStore),
      },
      expect.anything(),
    );
  });

  test('MongoDB stores should use the same connection', async () => {
    const mongoConnection = getMongoConnection();

    await InternetGatewayManager.init(mongoConnection);

    expect(MongoCertificateStore).toBeCalledWith(mongoConnection);
    expect(MongoPublicKeyStore).toBeCalledWith(mongoConnection);
    expect(vault.initPrivateKeyStore).toBeCalledWith(mongoConnection);
  });
});

describe('getCurrent', () => {
  test('Error should be thrown if current address is unset', async () => {
    const manager = new InternetGatewayManager(getMongoConnection(), keyStoreSet);

    await expect(manager.getCurrent()).rejects.toThrowWithMessage(
      InternetGatewayError,
      'Current id is unset',
    );
  });

  test('Error should be thrown if current address is set but key does not exist', async () => {
    const connection = getMongoConnection();
    const manager = new InternetGatewayManager(connection, keyStoreSet);
    const invalidId = 'does not exist';
    const config = new Config(connection);
    await config.set(ConfigKey.CURRENT_ID, invalidId);

    await expect(manager.getCurrent()).rejects.toThrowWithMessage(
      InternetGatewayError,
      `Internet gateway does not exist (id: ${invalidId})`,
    );
  });

  test('Current gateway should be returned if address is set', async () => {
    const mongoConnection = getMongoConnection();
    const manager = new InternetGatewayManager(mongoConnection, keyStoreSet);
    const { id } = await keyStoreSet.privateKeyStore.generateIdentityKeyPair();
    const config = new Config(mongoConnection);
    await config.set(ConfigKey.CURRENT_ID, id);

    const gateway = await manager.getCurrent();

    expect(gateway.id).toEqual(id);
  });
});
