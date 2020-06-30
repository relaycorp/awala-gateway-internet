import { CargoRelayService } from '@relaycorp/cogrpc';
import { get as getEnvVar } from 'env-var';
import { Server, ServerCredentials } from 'grpc';
import grpcHealthCheck from 'grpc-health-check';

import { MAX_RAMF_MESSAGE_SIZE } from '../constants';
import { makeServiceImplementation } from './service';

const NETLOC = '0.0.0.0:8080';

const MAX_RECEIVED_MESSAGE_LENGTH = MAX_RAMF_MESSAGE_SIZE + 256; // Include protobuf overhead
const MAX_CONCURRENT_CALLS = 3;
const MAX_METADATA_SIZE = 3_500; // ~2.5kib for a base64-encoded CCA + overhead
const MAX_CONNECTION_AGE_MINUTES = 15;
const MAX_CONNECTION_AGE_GRACE_SECONDS = 30;
const MAX_CONNECTION_IDLE_SECONDS = 5;

export async function runServer(): Promise<void> {
  const gatewayKeyIdBase64 = getEnvVar('GATEWAY_KEY_ID').required().asString();
  const cogrpcAddress = getEnvVar('COGRPC_ADDRESS').required().asString();
  const parcelStoreBucket = getEnvVar('OBJECT_STORE_BUCKET').required().asString();
  const natsServerUrl = getEnvVar('NATS_SERVER_URL').required().asString();
  const natsClusterId = getEnvVar('NATS_CLUSTER_ID').required().asString();

  const server = new Server({
    'grpc.max_concurrent_streams': MAX_CONCURRENT_CALLS,
    'grpc.max_connection_age_grace_ms': MAX_CONNECTION_AGE_GRACE_SECONDS * 1_000,
    'grpc.max_connection_age_ms': MAX_CONNECTION_AGE_MINUTES * 60 * 1_000,
    'grpc.max_connection_idle_ms': MAX_CONNECTION_IDLE_SECONDS * 1_000,
    'grpc.max_metadata_size': MAX_METADATA_SIZE,
    'grpc.max_receive_message_length': MAX_RECEIVED_MESSAGE_LENGTH,
  });
  const serviceImplementation = await makeServiceImplementation({
    cogrpcAddress,
    gatewayKeyIdBase64,
    natsClusterId,
    natsServerUrl,
    parcelStoreBucket,
  });
  server.addService(CargoRelayService, serviceImplementation);

  // TODO: Health checks should be probing backing services
  const healthCheckService = new grpcHealthCheck.Implementation({
    '': grpcHealthCheck.messages.HealthCheckResponse.ServingStatus.SERVING,
    CargoRelay: grpcHealthCheck.messages.HealthCheckResponse.ServingStatus.SERVING,
  });
  server.addService(grpcHealthCheck.service, healthCheckService);

  const bindResult = server.bind(NETLOC, ServerCredentials.createInsecure());
  if (bindResult < 0) {
    throw new Error(`Failed to listen on ${NETLOC}`);
  }
  server.start();
}
