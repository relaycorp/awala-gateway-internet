import { CargoRelayService } from '@relaycorp/relaynet-cogrpc';
import { get as getEnvVar } from 'env-var';
import { Server, ServerCredentials } from 'grpc';

import { makeServiceImplementation } from './service';

const NETLOC = '0.0.0.0:8080';

export function runServer(): void {
  const mongoUri = getEnvVar('MONGO_URI')
    .required()
    .asString();

  const server = new Server();
  const serviceImplementation = makeServiceImplementation({ mongoUri });
  server.addService(CargoRelayService, serviceImplementation);
  const bindResult = server.bind(NETLOC, ServerCredentials.createInsecure());
  if (bindResult < 0) {
    throw new Error(`Failed to listen on ${NETLOC}`);
  }
  server.start();
}
