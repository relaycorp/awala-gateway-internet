// tslint:disable:no-let

import { MockPrivateKeyStore, Parcel } from '@relaycorp/relaynet-core';
import { Connection } from 'mongoose';

import { mockSpy, PdaChain } from '../../_test_utils';
import * as privateKeyStore from '../../backingServices/privateKeyStore';
import { configureMockEnvVars, generatePdaChain, mockFastifyMongoose } from '../_test_utils';
import { ParcelStore } from '../parcelStore';

const BASE_ENV_VARS = { MONGO_URI: 'mongodb://example.com' };

export interface FixtureSet extends PdaChain {
  readonly mongooseConnection: Connection;
  readonly parcelStore: ParcelStore;
}

export function setUpCommonFixtures(): () => FixtureSet {
  const mockMongooseConnection: Connection = { whatIsThis: 'The Mongoose connection' } as any;
  mockFastifyMongoose({ db: mockMongooseConnection });

  const mockParcelStore: ParcelStore = {
    storeParcelFromPeerGateway: mockSpy(
      jest.spyOn(ParcelStore.prototype, 'storeParcelFromPeerGateway'),
      async (parcel: Parcel) => {
        return `parcels/${parcel.id}`;
      },
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
    await mockPrivateKeyStore.registerNodeKey(
      certificatePath.publicGatewayPrivateKey,
      certificatePath.publicGatewayCert,
    );
  });
  mockSpy(jest.spyOn(privateKeyStore, 'initVaultKeyStore'), () => mockPrivateKeyStore);

  const mockEnvVars = configureMockEnvVars(BASE_ENV_VARS);
  beforeEach(() => {
    const gatewayCertificate = certificatePath.publicGatewayCert;
    mockEnvVars({
      ...BASE_ENV_VARS,
      GATEWAY_KEY_ID: gatewayCertificate.getSerialNumber().toString('base64'),
    });
  });

  return () => ({
    mongooseConnection: mockMongooseConnection,
    parcelStore: mockParcelStore,
    ...certificatePath,
  });
}
