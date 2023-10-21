import { CertificationPath, MockPrivateKeyStore } from '@relaycorp/relaynet-core';
import { MongoCertificateStore } from '@relaycorp/awala-keystore-mongodb';

import * as keyStore from '../../backingServices/keystore';
import { ParcelStore } from '../../parcelStore';
import { GATEWAY_INTERNET_ADDRESS } from '../../testUtils/awala';
import { arrayToAsyncIterable } from '../../testUtils/iter';
import { mockSpy } from '../../testUtils/jest';
import { generatePdaChain, PdaChain } from '../../testUtils/pki';
import { Config, ConfigKey } from '../../utilities/config';
import { mockRedisPubSubClient, MockRedisPubSubClient } from '../../testUtils/redis';
import { makeTestServer, TestServerFixture } from '../../testUtils/fastify';
import { makeServer } from './server';
import { REQUIRED_ENV_VARS } from '../../testUtils/envVars';
import { type MockQueueEmitter, mockQueueEmitter } from '../../testUtils/eventing/mockQueueEmitter';

export interface PoWebFixtureSet extends PdaChain, TestServerFixture {
  readonly parcelStore: ParcelStore;
  readonly privateKeyStore: MockPrivateKeyStore;
  readonly redisPubSubClient: MockRedisPubSubClient;
  readonly emitter: MockQueueEmitter;
}

export function makePoWebTestServer(): () => PoWebFixtureSet {
  const cloudEventsRetriever = mockQueueEmitter();
  const redisPubSubClient = mockRedisPubSubClient();

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
      async () => true,
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
  mockSpy(jest.spyOn(keyStore, 'initPrivateKeyStore'), () => mockPrivateKeyStore);

  const getFixtures = makeTestServer(makeServer, {
    ...REQUIRED_ENV_VARS,
    PUBLIC_ADDRESS: GATEWAY_INTERNET_ADDRESS,
  });

  beforeEach(async () => {
    const { dbConnection } = getFixtures();

    const certificateStore = new MongoCertificateStore(dbConnection);
    await certificateStore.save(
      new CertificationPath(certificatePath.internetGatewayCert, []),
      internetGatewayId,
    );

    const config = new Config(dbConnection);
    await config.set(ConfigKey.CURRENT_ID, internetGatewayId);
  });

  return () => ({
    ...getFixtures(),
    parcelStore: mockParcelStore,
    privateKeyStore: mockPrivateKeyStore,
    redisPubSubClient,
    emitter: cloudEventsRetriever,
    ...certificatePath,
  });
}
