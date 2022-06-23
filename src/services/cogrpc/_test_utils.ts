import mongoose from 'mongoose';

import { setUpTestDBConnection } from '../../testUtils/db';
import { configureMockEnvVars } from '../../testUtils/envVars';
import { makeMockLogging, MockLogging } from '../../testUtils/logging';
import { ServiceImplementationOptions } from './service';
import SpyInstance = jest.SpyInstance;

export const STUB_PUBLIC_ADDRESS = 'gateway.com';
export const STUB_PUBLIC_ADDRESS_URL = `https://${STUB_PUBLIC_ADDRESS}`;
export const STUB_OBJECT_STORE_BUCKET = 'parcels-bucket';
const NATS_SERVER_URL = 'nats://example.com';
const NATS_CLUSTER_ID = 'nats-cluster-id';

interface Fixture {
  readonly getMongooseConnection: () => mongoose.Connection;
  readonly getSvcImplOptions: () => ServiceImplementationOptions;
  readonly getMockLogs: () => readonly object[];
}

export function setUpTestEnvironment(): Fixture {
  const getMongooseConnection = setUpTestDBConnection();

  configureMockEnvVars({
    OBJECT_STORE_ACCESS_KEY_ID: 'id',
    OBJECT_STORE_BACKEND: 'minio',
    OBJECT_STORE_ENDPOINT: 'http://localhost.example',
    OBJECT_STORE_SECRET_KEY: 's3cr3t',
    VAULT_KV_PREFIX: 'prefix',
    VAULT_TOKEN: 'token',
    VAULT_URL: 'http://vault.example',
  });

  let mockLogging: MockLogging;
  let mockGetMongooseConnection: SpyInstance;
  beforeEach(() => {
    mockLogging = makeMockLogging();
    mockGetMongooseConnection = jest.fn().mockImplementation(getMongooseConnection);
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
      publicAddress: STUB_PUBLIC_ADDRESS,
    }),
  };
}
