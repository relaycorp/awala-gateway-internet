import { derSerializePublicKey, KeyStoreSet, MockKeyStoreSet } from '@relaycorp/relaynet-core';
import { MongoCertificateStore, MongoPublicKeyStore } from '@relaycorp/awala-keystore-mongodb';
import { addDays, setMilliseconds } from 'date-fns';

import * as vault from '../backingServices/keystore';
import { InternetGatewayError } from '../errors';
import { setUpTestDBConnection } from '../testUtils/db';
import { mockSpy } from '../testUtils/jest';
import { Config, ConfigKey } from '../utilities/config';
import { InternetGatewayManager } from './InternetGatewayManager';
import { CERTIFICATE_TTL_DAYS } from '../pki';

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

describe('getOrCreateCurrent', () => {
  describe('Retrieval', () => {
    test('Error should be thrown if current address is set but key does not exist', async () => {
      const connection = getMongoConnection();
      const manager = new InternetGatewayManager(connection, keyStoreSet);
      const invalidId = 'invalid';
      const config = new Config(connection);
      await config.set(ConfigKey.CURRENT_ID, invalidId);

      await expect(manager.getOrCreateCurrent()).rejects.toThrowWithMessage(
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

      const gateway = await manager.getOrCreateCurrent();

      expect(gateway.id).toEqual(id);
    });
  });

  describe('Creation', () => {
    describe('Identity certificate', () => {
      test('Certificate path should be stored', async () => {
        const manager = new InternetGatewayManager(getMongoConnection(), keyStoreSet);

        const gateway = await manager.getOrCreateCurrent();

        await expect(
          keyStoreSet.certificateStore.retrieveLatest(gateway.id, gateway.id),
        ).resolves.toBeDefined();
      });

      test('Certificate should be self-issued with identity key pair', async () => {
        const manager = new InternetGatewayManager(getMongoConnection(), keyStoreSet);

        const gateway = await manager.getOrCreateCurrent();

        const { leafCertificate } = (await keyStoreSet.certificateStore.retrieveLatest(
          gateway.id,
          gateway.id,
        ))!!;
        await expect(
          derSerializePublicKey(await leafCertificate.getPublicKey()),
        ).resolves.toStrictEqual(await derSerializePublicKey(gateway.identityKeyPair.publicKey));
      });

      test('Certificate should be valid for the expected duration', async () => {
        const manager = new InternetGatewayManager(getMongoConnection(), keyStoreSet);
        const beforeIssuance = setMilliseconds(new Date(), 0);

        const gateway = await manager.getOrCreateCurrent();

        const afterIssuance = setMilliseconds(new Date(), 0);
        const { leafCertificate } = (await keyStoreSet.certificateStore.retrieveLatest(
          gateway.id,
          gateway.id,
        ))!!;
        expect(leafCertificate.startDate).toBeAfterOrEqualTo(beforeIssuance);
        expect(leafCertificate.startDate).toBeBeforeOrEqualTo(afterIssuance);
        expect(leafCertificate.expiryDate).toBeBeforeOrEqualTo(
          addDays(afterIssuance, CERTIFICATE_TTL_DAYS),
        );
        expect(leafCertificate.expiryDate).toBeAfterOrEqualTo(
          addDays(beforeIssuance, CERTIFICATE_TTL_DAYS),
        );
      });

      test('Path should have no intermediate CAs', async () => {
        const manager = new InternetGatewayManager(getMongoConnection(), keyStoreSet);

        const gateway = await manager.getOrCreateCurrent();

        const { certificateAuthorities } = (await keyStoreSet.certificateStore.retrieveLatest(
          gateway.id,
          gateway.id,
        ))!!;
        expect(certificateAuthorities).toBeEmpty();
      });
    });

    test('New gateway id should be stored as current', async () => {
      const connection = getMongoConnection();
      const manager = new InternetGatewayManager(connection, keyStoreSet);

      const gateway = await manager.getOrCreateCurrent();

      const config = new Config(connection);
      expect(gateway.id).toBe(await config.get(ConfigKey.CURRENT_ID));
    });
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
