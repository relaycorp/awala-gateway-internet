import { CargoRelayService } from '@relaycorp/relaynet-cogrpc';
import { Server, ServerCredentials } from 'grpc';

import * as service from './service';

const NETLOC = '0.0.0.0:8080';

export function runServer(): void {
  const server = new Server();
  server.addService(CargoRelayService, service);
  const bindResult = server.bind(NETLOC, ServerCredentials.createInsecure());
  if (bindResult < 0) {
    throw new Error(`Failed to listen on ${NETLOC}`);
  }
  server.start();
}
