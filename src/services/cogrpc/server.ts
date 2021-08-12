import { KeyCertPair, Server, ServerCredentials } from '@grpc/grpc-js';
import { CargoRelayService } from '@relaycorp/cogrpc';
import { get as getEnvVar } from 'env-var';
import grpcHealthCheck from 'grpc-health-check';
import { Logger } from 'pino';
import * as selfsigned from 'selfsigned';
import { configureExitHandling } from '../../utilities/exitHandling';

import { MAX_RAMF_MESSAGE_SIZE } from '../../constants';
import { makeLogger } from '../../utilities/logging';
import { makeServiceImplementation } from './service';

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

  const gatewayKeyIdBase64 = getEnvVar('GATEWAY_KEY_ID').required().asString();
  const publicAddress = getEnvVar('PUBLIC_ADDRESS').required().asString();
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
    baseLogger,
    gatewayKeyIdBase64,
    natsClusterId,
    natsServerUrl,
    parcelStoreBucket,
    publicAddress,
  });
  server.addService(CargoRelayService, serviceImplementation);

  // TODO: Health checks should be probing backing services
  const healthCheckService = new grpcHealthCheck.Implementation({
    '': grpcHealthCheck.messages.HealthCheckResponse.ServingStatus.SERVING,
    'relaynet.cogrpc.CargoRelay':
      grpcHealthCheck.messages.HealthCheckResponse.ServingStatus.SERVING,
  });
  server.addService(grpcHealthCheck.service, healthCheckService);

  const certificate = await selfIssueCertificate();
  await new Promise((resolve, reject) => {
    server.bindAsync(NETLOC, ServerCredentials.createSsl(null, [certificate]), (error) => {
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

/**
 * Self issue certificate.
 *
 * As a workaround for: https://github.com/kubernetes/ingress-gce/issues/18#issuecomment-694815076
 */
async function selfIssueCertificate(): Promise<KeyCertPair> {
  const ipAddress = getEnvVar('SERVER_IP_ADDRESS').required().asString();
  const keys = selfsigned.generate([{ name: 'commonName', value: ipAddress }], {
    days: 365,
    extensions: [
      {
        altNames: [
          {
            ip: ipAddress,
            type: 7, // IP Address
          },
        ],
        name: 'subjectAltName',
      },
    ],
  });
  return { cert_chain: Buffer.from(keys.cert), private_key: Buffer.from(keys.private) };
}
