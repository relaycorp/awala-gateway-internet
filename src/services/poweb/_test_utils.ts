import { CertificationPath, MockPrivateKeyStore, Parcel } from '@relaycorp/relaynet-core';
import { MongoCertificateStore } from '@relaycorp/awala-keystore-mongodb';
import { Connection } from 'mongoose';

import * as vault from '../../backingServices/keystore';
import { ParcelStore } from '../../parcelStore';
import { GATEWAY_INTERNET_ADDRESS } from '../../testUtils/awala';
import { setUpTestDBConnection } from '../../testUtils/db';
import { configureMockEnvVars } from '../../testUtils/envVars';
import { arrayToAsyncIterable } from '../../testUtils/iter';
import { mockSpy } from '../../testUtils/jest';
import { generatePdaChain, PdaChain } from '../../testUtils/pki';
import { Config, ConfigKey } from '../../utilities/config';

export interface FixtureSet extends PdaChain {
  readonly getMongooseConnection: () => Connection;
  readonly parcelStore: ParcelStore;
  readonly privateKeyStore: MockPrivateKeyStore;
}

export function setUpCommonFixtures(): () => FixtureSet {
  const getMongooseConnection = setUpTestDBConnection();

  const mockParcelStore: ParcelStore = {
    liveStreamParcelsForPrivatePeer: mockSpy(
      jest.spyOn(ParcelStore.prototype, 'liveStreamParcelsForPrivatePeer'),
      async function* (): AsyncIterable<any> {
        // tslint:disable-next-line:no-unused-expression
        await new Promise(() => 'A promise that never resolves');
      },
    ),
    storeParcelFromPrivatePeer: mockSpy(
      jest.spyOn(ParcelStore.prototype, 'storeParcelFromPrivatePeer'),
      async (parcel: Parcel) => {
        return `parcels/${parcel.id}`;
      },
    ),
    streamParcelsForPrivatePeer: mockSpy(
      jest.spyOn(ParcelStore.prototype, 'streamParcelsForPrivatePeer'),
      () => arrayToAsyncIterable([]),
    ),
  } as any;
  mockSpy(jest.spyOn(ParcelStore, 'initFromEnv'), () => mockParcelStore);

  let internetGatewayId: string;
  let certificatePath: PdaChain;
  beforeAll(async () => {
    certificatePath = await generatePdaChain();
    internetGatewayId = await certificatePath.internetGatewayCert.calculateSubjectId();
  });

  let mockPrivateKeyStore: MockPrivateKeyStore;
  beforeEach(async () => {
    mockPrivateKeyStore = new MockPrivateKeyStore();
    await mockPrivateKeyStore.saveIdentityKey(
      internetGatewayId,
      certificatePath.internetGatewayPrivateKey,
    );
  });
  mockSpy(jest.spyOn(vault, 'initPrivateKeyStore'), () => mockPrivateKeyStore);

  beforeEach(async () => {
    const connection = getMongooseConnection();

    const certificateStore = new MongoCertificateStore(connection);
    await certificateStore.save(
      new CertificationPath(certificatePath.internetGatewayCert, []),
      internetGatewayId,
    );

    const config = new Config(connection);
    await config.set(ConfigKey.CURRENT_ID, internetGatewayId);
  });

  const mockEnvVars = configureMockEnvVars();
  beforeEach(() => {
    mockEnvVars({
      GATEWAY_VERSION: '1.0.2',
      PUBLIC_ADDRESS: GATEWAY_INTERNET_ADDRESS,
    });
  });

  return () => ({
    getMongooseConnection,
    parcelStore: mockParcelStore,
    privateKeyStore: mockPrivateKeyStore,
    ...certificatePath,
  });
}
