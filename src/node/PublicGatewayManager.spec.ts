import { KeyStoreSet, MockKeyStoreSet } from '@relaycorp/relaynet-core';

import * as vault from '../backingServices/keystore';
import { PublicGatewayError } from '../errors';
import { MongoCertificateStore } from '../keystores/MongoCertificateStore';
import { MongoPublicKeyStore } from '../keystores/MongoPublicKeyStore';
import { setUpTestDBConnection } from '../testUtils/db';
import { mockSpy } from '../testUtils/jest';
import { Config, ConfigKey } from '../utilities/config';
import { PublicGatewayManager } from './PublicGatewayManager';

jest.mock('../keystores/MongoCertificateStore');
jest.mock('../keystores/MongoPublicKeyStore');

const getMongoConnection = setUpTestDBConnection();

const keyStoreSet = new MockKeyStoreSet();
beforeEach(() => {
  keyStoreSet.clear();
});

describe('init', () => {
  mockSpy(jest.spyOn(vault, 'initPrivateKeyStore'), () => keyStoreSet.privateKeyStore);

  test('Manager should be output', async () => {
    await expect(PublicGatewayManager.init(getMongoConnection())).resolves.toBeInstanceOf(
      PublicGatewayManager,
    );
  });

  test('Key stores should be used', async () => {
    const manager = await PublicGatewayManager.init(getMongoConnection());

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

    await PublicGatewayManager.init(mongoConnection);

    expect(MongoCertificateStore).toBeCalledWith(mongoConnection);
    expect(MongoPublicKeyStore).toBeCalledWith(mongoConnection);
    expect(vault.initPrivateKeyStore).toBeCalledWith(mongoConnection);
  });
});

describe('getCurrent', () => {
  test('Error should be thrown if current address is unset', async () => {
    const manager = new PublicGatewayManager(getMongoConnection(), keyStoreSet);

    await expect(manager.getCurrent()).rejects.toThrowWithMessage(
      PublicGatewayError,
      'Current id is unset',
    );
  });

  test('Error should be thrown if current address is set but key does not exist', async () => {
    const connection = getMongoConnection();
    const manager = new PublicGatewayManager(connection, keyStoreSet);
    const invalidId = 'does not exist';
    const config = new Config(connection);
    await config.set(ConfigKey.CURRENT_ID, invalidId);

    await expect(manager.getCurrent()).rejects.toThrowWithMessage(
      PublicGatewayError,
      `Public gateway does not exist (id: ${invalidId})`,
    );
  });

  test('Current gateway should be returned if address is set', async () => {
    const mongoConnection = getMongoConnection();
    const manager = new PublicGatewayManager(mongoConnection, keyStoreSet);
    const { id } = await keyStoreSet.privateKeyStore.generateIdentityKeyPair();
    const config = new Config(mongoConnection);
    await config.set(ConfigKey.CURRENT_ID, id);

    const gateway = await manager.getCurrent();

    expect(gateway.id).toEqual(id);
  });
});
