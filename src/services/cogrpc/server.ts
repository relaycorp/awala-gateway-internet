import { CargoRelayService } from '@relaycorp/relaynet-cogrpc';
import { Server, ServerCredentials } from 'grpc';

import * as service from './service';

export function runServer(): void {
  const server = new Server();
  server.addService(CargoRelayService, service);
  const netloc = '0.0.0.0:8080';
  const bindResult = server.bind(netloc, ServerCredentials.createInsecure());
  if (bindResult < 0) {
    throw new Error(`Failed to listen on ${netloc}`);
  }
  server.start();
}
