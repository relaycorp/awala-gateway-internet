import { CargoRelayService } from '@relaycorp/relaynet-cogrpc';
import { get as getEnvVar } from 'env-var';
import { Server, ServerCredentials } from 'grpc';

import { MAX_RAMF_MESSAGE_SIZE } from '../constants';
import { makeServiceImplementation } from './service';

const NETLOC = '0.0.0.0:8080';

// Add some wiggle room to the maximum message size so we can include the overhead in serializing
// Protocol Buffers messages.
const MAX_RECEIVED_MESSAGE_LENGTH = MAX_RAMF_MESSAGE_SIZE + 256;

export function runServer(): void {
  const gatewayKeyIdBase64 = getEnvVar('GATEWAY_KEY_ID')
    .required()
    .asString();
  const cogrpcAddress = getEnvVar('COGRPC_ADDRESS')
    .required()
    .asString();
  const parcelStoreBucket = getEnvVar('PARCEL_STORE_BUCKET')
    .required()
    .asString();
  const mongoUri = getEnvVar('MONGO_URI')
    .required()
    .asString();
  const natsServerUrl = getEnvVar('NATS_SERVER_URL')
    .required()
    .asString();
  const natsClusterId = getEnvVar('NATS_CLUSTER_ID')
    .required()
    .asString();

  const server = new Server({ 'grpc.max_receive_message_length': MAX_RECEIVED_MESSAGE_LENGTH });
  const serviceImplementation = makeServiceImplementation({
    cogrpcAddress,
    gatewayKeyIdBase64,
    mongoUri,
    natsClusterId,
    natsServerUrl,
    parcelStoreBucket,
  });
  server.addService(CargoRelayService, serviceImplementation);
  const bindResult = server.bind(NETLOC, ServerCredentials.createInsecure());
  if (bindResult < 0) {
    throw new Error(`Failed to listen on ${NETLOC}`);
  }
  server.start();
}
