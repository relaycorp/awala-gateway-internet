import * as grpc from '@grpc/grpc-js';
import { Connection } from 'mongoose';
import { Duplex } from 'stream';

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
  readonly getMongooseConnection: () => Connection;
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

export class MockGrpcBidiCall<Input, Output> extends Duplex {
  // tslint:disable-next-line:readonly-array readonly-keyword
  public input: Input[] = [];
  // tslint:disable-next-line:readonly-array readonly-keyword
  public output: Output[] = [];

  public readonly metadata: grpc.Metadata;

  constructor() {
    super({ objectMode: true });

    this.metadata = new grpc.Metadata();

    // Mimic what the gRPC server would do
    this.on('error', () => this.end());

    jest.spyOn(this, 'emit' as any);
    jest.spyOn(this, 'on' as any);
    jest.spyOn(this, 'end' as any);
    jest.spyOn(this, 'write' as any);
  }

  public _read(_size: number): void {
    while (this.output.length) {
      const canPushAgain = this.push(this.output.shift());
      if (!canPushAgain) {
        return;
      }
    }

    this.push(null);
  }

  public _write(value: Input, _encoding: string, callback: (error?: Error) => void): void {
    this.input.push(value);
    callback();
  }

  public end(cb?: () => void): void {
    super.end(cb);
    this.emit('end');
  }

  public getPeer(): string {
    return '127.0.0.1';
  }

  public convertToGrpcStream(): grpc.ServerDuplexStream<Input, Output> {
    // Unfortunately, ServerDuplexStream's constructor is private so we have to resort to this
    // ugly hack
    return this as unknown as grpc.ServerDuplexStream<Input, Output>;
  }
}
