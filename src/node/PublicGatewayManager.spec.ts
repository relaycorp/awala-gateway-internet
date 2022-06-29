import { KeyStoreSet, MockKeyStoreSet } from '@relaycorp/relaynet-core';
import { addDays, addSeconds } from 'date-fns';

import * as vault from '../backingServices/keystore';
import { PublicGatewayError } from '../errors';
import { MongoCertificateStore } from '../keystores/MongoCertificateStore';
import { MongoPublicKeyStore } from '../keystores/MongoPublicKeyStore';
import { CERTIFICATE_TTL_DAYS } from '../pki';
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
    const { privateAddress } = await keyStoreSet.privateKeyStore.generateIdentityKeyPair();
    const gatewayConstructorSpy = jest.fn();
    await manager.get(privateAddress, gatewayConstructorSpy);
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
  });
});

describe('generate', () => {
  test('Private key should be stored', async () => {
    const manager = new PublicGatewayManager(getMongoConnection(), keyStoreSet);

    const privateAddress = await manager.generate();

    await expect(
      keyStoreSet.privateKeyStore.retrieveIdentityKey(privateAddress),
    ).resolves.toBeTruthy();
  });

  describe('Certificate', () => {
    test('Certificate should be stored', async () => {
      const manager = new PublicGatewayManager(getMongoConnection(), keyStoreSet);

      const privateAddress = await manager.generate();

      await expect(
        keyStoreSet.certificateStore.retrieveLatest(privateAddress, privateAddress),
      ).resolves.toBeTruthy();
    });

    test('Certificate should be self-issued', async () => {
      const manager = new PublicGatewayManager(getMongoConnection(), keyStoreSet);

      const privateAddress = await manager.generate();

      const certificatePath = await keyStoreSet.certificateStore.retrieveLatest(
        privateAddress,
        privateAddress,
      );
      expect(certificatePath!.certificateAuthorities).toHaveLength(0);
      await expect(
        certificatePath!.leafCertificate.calculateSubjectPrivateAddress(),
      ).resolves.toEqual(certificatePath!.leafCertificate.getIssuerPrivateAddress());
    });

    test('Certificate should last 360 days', async () => {
      const manager = new PublicGatewayManager(getMongoConnection(), keyStoreSet);
      const preGenerationDate = new Date();

      const privateAddress = await manager.generate();

      const { leafCertificate: certificate } = (await keyStoreSet.certificateStore.retrieveLatest(
        privateAddress,
        privateAddress,
      ))!;
      const expectedExpiryDate = addDays(preGenerationDate, CERTIFICATE_TTL_DAYS);
      expect(certificate.expiryDate).toBeAfterOrEqualTo(expectedExpiryDate);
      expect(certificate.expiryDate).toBeBeforeOrEqualTo(addSeconds(expectedExpiryDate, 5));
    });
  });

  test('Private address should be set as current', async () => {
    const mongoConnection = getMongoConnection();
    const manager = new PublicGatewayManager(mongoConnection, keyStoreSet);
    const config = new Config(mongoConnection);

    const privateAddress = await manager.generate();

    await expect(config.get(ConfigKey.CURRENT_PRIVATE_ADDRESS)).resolves.toEqual(privateAddress);
  });
});

describe('getCurrentPrivateAddress', () => {
  test('Null should be returned if current address is unset', async () => {
    const manager = new PublicGatewayManager(getMongoConnection(), keyStoreSet);

    await expect(manager.getCurrentPrivateAddress()).resolves.toBeNull();
  });

  test('Private address should be returned if set', async () => {
    const mongoConnection = getMongoConnection();
    const manager = new PublicGatewayManager(mongoConnection, keyStoreSet);
    const privateAddress = '0deadbeef';
    const config = new Config(mongoConnection);
    await config.set(ConfigKey.CURRENT_PRIVATE_ADDRESS, privateAddress);

    await expect(manager.getCurrentPrivateAddress()).resolves.toEqual(privateAddress);
  });
});

describe('getCurrent', () => {
  test('Error should be thrown if current address is unset', async () => {
    const manager = new PublicGatewayManager(getMongoConnection(), keyStoreSet);

    await expect(manager.getCurrent()).rejects.toThrowWithMessage(
      PublicGatewayError,
      'Current private address is unset',
    );
  });

  test('Error should be thrown if current address is set but key does not exist', async () => {
    const connection = getMongoConnection();
    const manager = new PublicGatewayManager(connection, keyStoreSet);
    const privateAddress = 'does not exist';
    const config = new Config(connection);
    await config.set(ConfigKey.CURRENT_PRIVATE_ADDRESS, privateAddress);

    await expect(manager.getCurrent()).rejects.toThrowWithMessage(
      PublicGatewayError,
      `Public gateway does not exist (private address: ${privateAddress})`,
    );
  });

  test('Current gateway should be returned if address is set', async () => {
    const mongoConnection = getMongoConnection();
    const manager = new PublicGatewayManager(mongoConnection, keyStoreSet);
    const { privateAddress } = await keyStoreSet.privateKeyStore.generateIdentityKeyPair();
    const config = new Config(mongoConnection);
    await config.set(ConfigKey.CURRENT_PRIVATE_ADDRESS, privateAddress);

    const gateway = await manager.getCurrent();

    expect(gateway.privateAddress).toEqual(privateAddress);
  });
});
