import { CertificationPath, MockPrivateKeyStore, Parcel } from '@relaycorp/relaynet-core';
import { Connection } from 'mongoose';

import * as vault from '../../backingServices/keystore';
import { MongoCertificateStore } from '../../keystores/MongoCertificateStore';
import { ParcelStore } from '../../parcelStore';
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
    liveStreamActiveParcelsForGateway: mockSpy(
      jest.spyOn(ParcelStore.prototype, 'liveStreamParcelsForPrivatePeer'),
      async function* (): AsyncIterable<any> {
        // tslint:disable-next-line:no-unused-expression
        await new Promise(() => 'A promise that never resolves');
      },
    ),
    storeParcelFromPeerGateway: mockSpy(
      jest.spyOn(ParcelStore.prototype, 'storeParcelFromPrivatePeer'),
      async (parcel: Parcel) => {
        return `parcels/${parcel.id}`;
      },
    ),
    streamActiveParcelsForGateway: mockSpy(
      jest.spyOn(ParcelStore.prototype, 'streamParcelsForPrivatePeer'),
      () => arrayToAsyncIterable([]),
    ),
  } as any;
  mockSpy(jest.spyOn(ParcelStore, 'initFromEnv'), () => mockParcelStore);

  let privateAddress: string;
  let certificatePath: PdaChain;
  beforeAll(async () => {
    certificatePath = await generatePdaChain();
    privateAddress = await certificatePath.publicGatewayCert.calculateSubjectId();
  });

  let mockPrivateKeyStore: MockPrivateKeyStore;
  beforeEach(async () => {
    mockPrivateKeyStore = new MockPrivateKeyStore();
    await mockPrivateKeyStore.saveIdentityKey(
      privateAddress,
      certificatePath.publicGatewayPrivateKey,
    );
  });
  mockSpy(jest.spyOn(vault, 'initPrivateKeyStore'), () => mockPrivateKeyStore);

  beforeEach(async () => {
    const connection = getMongooseConnection();

    const certificateStore = new MongoCertificateStore(connection);
    await certificateStore.save(
      new CertificationPath(certificatePath.publicGatewayCert, []),
      privateAddress,
    );

    const config = new Config(connection);
    await config.set(ConfigKey.CURRENT_ID, privateAddress);
  });

  const mockEnvVars = configureMockEnvVars();
  beforeEach(() => {
    mockEnvVars({
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
