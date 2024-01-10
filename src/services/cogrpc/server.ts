import { Server, ServerCredentials } from '@grpc/grpc-js';
import { CargoRelayService } from '@relaycorp/cogrpc';
import * as grpcHealthCheck from 'grpc-js-health-check';
import { Logger } from 'pino';

import { createMongooseConnectionFromEnv } from '../../backingServices/mongo';
import { configureExitHandling } from '../../utilities/exitHandling';
import { MAX_RAMF_MESSAGE_SIZE } from '../../constants';
import { makeLogger } from '../../utilities/logging';
import { makeService } from './service';
import { QueueEmitter } from '../../utilities/backgroundQueue/QueueEmitter';

const NETLOC = '0.0.0.0:8080';

const MAX_RECEIVED_MESSAGE_LENGTH = MAX_RAMF_MESSAGE_SIZE + 256; // Include protobuf overhead
const MAX_CONCURRENT_CALLS = 3;
const MAX_METADATA_SIZE = 6_000; // ~4.9 kib for a base64-encoded CCA + overhead
const MAX_CONNECTION_AGE_MINUTES = 15;
const MAX_CONNECTION_AGE_GRACE_SECONDS = 30;
const MAX_CONNECTION_IDLE_SECONDS = 5;

export async function runServer(logger?: Logger): Promise<void> {
  const baseLogger = logger ?? makeLogger();
  configureExitHandling(baseLogger);

  const server = new Server({
    'grpc.max_concurrent_streams': MAX_CONCURRENT_CALLS,
    'grpc.max_connection_age_grace_ms': MAX_CONNECTION_AGE_GRACE_SECONDS * 1_000,
    'grpc.max_connection_age_ms': MAX_CONNECTION_AGE_MINUTES * 60 * 1_000,
    'grpc.max_connection_idle_ms': MAX_CONNECTION_IDLE_SECONDS * 1_000,
    'grpc.max_metadata_size': MAX_METADATA_SIZE,
    'grpc.max_receive_message_length': MAX_RECEIVED_MESSAGE_LENGTH,
  });

  const queueEmitter = await QueueEmitter.init();
  const serviceImplementation = await makeService({
    baseLogger,
    getMongooseConnection: createMongooseConnectionFromEnv,
    queueEmitter,
  });
  server.addService(CargoRelayService, serviceImplementation as any);

  // TODO: Health checks should be probing backing services
  const healthCheckService = new grpcHealthCheck.Implementation({
    '': grpcHealthCheck.servingStatus.SERVING,
    'relaynet.cogrpc.CargoRelay': grpcHealthCheck.servingStatus.SERVING,
  });
  server.addService(grpcHealthCheck.service, healthCheckService as any);

  await new Promise<void>((resolve, reject) => {
    server.bindAsync(NETLOC, ServerCredentials.createInsecure(), (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  server.start();

  baseLogger.info('Ready to receive requests');
}
