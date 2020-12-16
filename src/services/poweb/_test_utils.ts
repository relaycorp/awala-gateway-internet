import { MockPrivateKeyStore, Parcel } from '@relaycorp/relaynet-core';
import { Connection } from 'mongoose';

import { arrayToAsyncIterable, mockSpy, MONGO_ENV_VARS, PdaChain } from '../../_test_utils';
import * as privateKeyStore from '../../backingServices/keyStores';
import { configureMockEnvVars, generatePdaChain, mockFastifyMongoose } from '../_test_utils';
import { ParcelStore } from '../parcelStore';

export interface FixtureSet extends PdaChain {
  readonly mongooseConnection: Connection;
  readonly parcelStore: ParcelStore;
}

export function setUpCommonFixtures(): () => FixtureSet {
  const mockMongooseConnection: Connection = { whatIsThis: 'The Mongoose connection' } as any;
  mockFastifyMongoose({ db: mockMongooseConnection });

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
    await mockPrivateKeyStore.registerNodeKey(
      certificatePath.publicGatewayPrivateKey,
      certificatePath.publicGatewayCert,
    );
  });
  mockSpy(jest.spyOn(privateKeyStore, 'initVaultKeyStore'), () => mockPrivateKeyStore);

  const mockEnvVars = configureMockEnvVars(MONGO_ENV_VARS);
  beforeEach(() => {
    const gatewayCertificate = certificatePath.publicGatewayCert;
    mockEnvVars({
      ...MONGO_ENV_VARS,
      GATEWAY_KEY_ID: gatewayCertificate.getSerialNumber().toString('base64'),
    });
  });

  return () => ({
    mongooseConnection: mockMongooseConnection,
    parcelStore: mockParcelStore,
    ...certificatePath,
  });
}
