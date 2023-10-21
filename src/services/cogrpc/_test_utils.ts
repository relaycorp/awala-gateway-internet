import { MockPrivateKeyStore } from '@relaycorp/relaynet-core';
import { Connection } from 'mongoose';
import * as keystore from '../../backingServices/keystore';
import { GATEWAY_INTERNET_ADDRESS } from '../../testUtils/awala';

import { setUpTestDBConnection } from '../../testUtils/db';
import { configureMockEnvVars } from '../../testUtils/envVars';
import { mockSpy } from '../../testUtils/jest';
import { makeMockLogging, MockLogging } from '../../testUtils/logging';
import { ServiceOptions } from './service';
import { MockQueueEmitter, mockQueueEmitter } from '../../testUtils/eventing/mockQueueEmitter';

import SpyInstance = jest.SpyInstance;

export const STUB_OBJECT_STORE_BUCKET = 'parcels-bucket';

interface Fixture {
  readonly getMongooseConnection: () => Connection;
  readonly getSvcImplOptions: () => ServiceOptions;
  readonly getMockLogs: () => readonly object[];
  readonly getPrivateKeystore: () => MockPrivateKeyStore;
  readonly queueEmitter: MockQueueEmitter;
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

  const queueEmitter = mockQueueEmitter();

  return {
    getMockLogs: () => mockLogging.logs,
    getMongooseConnection,
    getSvcImplOptions: () => ({
      baseLogger: mockLogging.logger,
      getMongooseConnection: mockGetMongooseConnection as any,
      parcelStoreBucket: STUB_OBJECT_STORE_BUCKET,
      queueEmitter,
    }),
    getPrivateKeystore: () => privateKeyStore,
    queueEmitter,
  };
}
