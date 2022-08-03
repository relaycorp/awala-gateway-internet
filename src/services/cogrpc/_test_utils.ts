import { MockPrivateKeyStore } from '@relaycorp/relaynet-core';
import { Connection } from 'mongoose';
import * as keystore from '../../backingServices/keystore';
import { GATEWAY_INTERNET_ADDRESS } from '../../testUtils/awala';

import { setUpTestDBConnection } from '../../testUtils/db';
import { configureMockEnvVars } from '../../testUtils/envVars';
import { mockSpy } from '../../testUtils/jest';
import { makeMockLogging, MockLogging } from '../../testUtils/logging';
import { ServiceOptions } from './service';
import SpyInstance = jest.SpyInstance;

export const STUB_OBJECT_STORE_BUCKET = 'parcels-bucket';
const NATS_SERVER_URL = 'nats://example.com';
const NATS_CLUSTER_ID = 'nats-cluster-id';

interface Fixture {
  readonly getMongooseConnection: () => Connection;
  readonly getSvcImplOptions: () => ServiceOptions;
  readonly getMockLogs: () => readonly object[];
  readonly getPrivateKeystore: () => MockPrivateKeyStore;
}

export function setUpTestEnvironment(): Fixture {
  const getMongooseConnection = setUpTestDBConnection();

  configureMockEnvVars({
    OBJECT_STORE_ACCESS_KEY_ID: 'id',
    OBJECT_STORE_BACKEND: 'minio',
    OBJECT_STORE_BUCKET: STUB_OBJECT_STORE_BUCKET,
    OBJECT_STORE_ENDPOINT: 'http://localhost.example',
    OBJECT_STORE_SECRET_KEY: 's3cr3t',
    PUBLIC_ADDRESS: GATEWAY_INTERNET_ADDRESS,
  });

  let mockLogging: MockLogging;
  let mockGetMongooseConnection: SpyInstance;
  beforeEach(() => {
    mockLogging = makeMockLogging();
    mockGetMongooseConnection = jest.fn().mockImplementation(getMongooseConnection);
  });

  const privateKeyStore = new MockPrivateKeyStore();
  mockSpy(jest.spyOn(keystore, 'initPrivateKeyStore'), () => privateKeyStore);
  beforeEach(() => {
    privateKeyStore.clear();
  });

  return {
    getMockLogs: () => mockLogging.logs,
    getMongooseConnection,
    getSvcImplOptions: () => ({
      baseLogger: mockLogging.logger,
      getMongooseConnection: mockGetMongooseConnection as any,
      natsClusterId: NATS_CLUSTER_ID,
      natsServerUrl: NATS_SERVER_URL,
      parcelStoreBucket: STUB_OBJECT_STORE_BUCKET,
      internetAddress: GATEWAY_INTERNET_ADDRESS,
    }),
    getPrivateKeystore: () => privateKeyStore,
  };
}
