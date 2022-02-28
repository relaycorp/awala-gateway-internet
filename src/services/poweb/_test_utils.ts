import { MockPrivateKeyStore, Parcel } from '@relaycorp/relaynet-core';
import { Connection } from 'mongoose';

import * as vault from '../../backingServices/vault';
import { MongoCertificateStore } from '../../keystores/MongoCertificateStore';
import { ParcelStore } from '../../parcelStore';
import { MONGO_ENV_VARS, setUpTestDBConnection } from '../../testUtils/db';
import { arrayToAsyncIterable } from '../../testUtils/iter';
import { mockSpy } from '../../testUtils/jest';
import { generatePdaChain, PdaChain } from '../../testUtils/pki';
import { Config, ConfigKey } from '../../utilities/config';
import { configureMockEnvVars, mockFastifyMongoose } from '../_test_utils';

export interface FixtureSet extends PdaChain {
  readonly getMongooseConnection: () => Connection;
  readonly parcelStore: ParcelStore;
  readonly privateKeyStore: MockPrivateKeyStore;
}

export function setUpCommonFixtures(): () => FixtureSet {
  const getMongooseConnection = setUpTestDBConnection();
  mockFastifyMongoose(() => ({ db: getMongooseConnection() }));

  const mockParcelStore: ParcelStore = {
    liveStreamActiveParcelsForGateway: mockSpy(
      jest.spyOn(ParcelStore.prototype, 'liveStreamActiveParcelsForGateway'),
      async function* (): AsyncIterable<any> {
        // tslint:disable-next-line:no-unused-expression
        await new Promise(() => 'A promise that never resolves');
      },
    ),
    storeParcelFromPeerGateway: mockSpy(
      jest.spyOn(ParcelStore.prototype, 'storeParcelFromPeerGateway'),
      async (parcel: Parcel) => {
        return `parcels/${parcel.id}`;
      },
    ),
    streamActiveParcelsForGateway: mockSpy(
      jest.spyOn(ParcelStore.prototype, 'streamActiveParcelsForGateway'),
      () => arrayToAsyncIterable([]),
    ),
  } as any;
  mockSpy(jest.spyOn(ParcelStore, 'initFromEnv'), () => mockParcelStore);

  let certificatePath: PdaChain;
  beforeAll(async () => {
    certificatePath = await generatePdaChain();
  });

  let mockPrivateKeyStore: MockPrivateKeyStore;
  beforeEach(async () => {
    mockPrivateKeyStore = new MockPrivateKeyStore();
    await mockPrivateKeyStore.saveIdentityKey(certificatePath.publicGatewayPrivateKey);
  });
  mockSpy(jest.spyOn(vault, 'initVaultKeyStore'), () => mockPrivateKeyStore);

  beforeEach(async () => {
    const connection = getMongooseConnection();

    const certificateStore = new MongoCertificateStore(connection);
    await certificateStore.save(certificatePath.publicGatewayCert);

    const config = new Config(connection);
    await config.set(
      ConfigKey.CURRENT_PRIVATE_ADDRESS,
      await certificatePath.publicGatewayCert.calculateSubjectPrivateAddress(),
    );
  });

  const mockEnvVars = configureMockEnvVars(MONGO_ENV_VARS);
  beforeEach(() => {
    mockEnvVars({
      ...MONGO_ENV_VARS,
      GATEWAY_VERSION: '1.0.2',
    });
  });

  return () => ({
    getMongooseConnection,
    parcelStore: mockParcelStore,
    privateKeyStore: mockPrivateKeyStore,
    ...certificatePath,
  });
}
