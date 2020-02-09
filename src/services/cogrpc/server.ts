import { CargoDelivery, CargoDeliveryAck, CargoRelayService } from '@relaycorp/relaynet-cogrpc';
import * as grpc from 'grpc';

export function runServer(): void {
  // tslint:disable-next-line:no-console
  console.log('Starting server...');
  const server = new grpc.Server();
  server.addService(CargoRelayService, {
    deliverCargo(call: grpc.ServerDuplexStream<CargoDelivery, CargoDeliveryAck>): void {
      call.on('data', (delivery: CargoDelivery): void => {
        // tslint:disable-next-line:no-console
        console.log('Received cargo', { delivery });
        const ack: CargoDeliveryAck = { id: delivery.id };
        call.write(ack); // ACK
      });

      call.on('end', () => {
        // tslint:disable-next-line:no-console
        console.log('Call ended');
        call.end();
      });
    },
    async collectCargo(
      _call: grpc.ServerDuplexStream<CargoDeliveryAck, CargoDelivery>,
    ): Promise<void> {
      throw new Error('Unimplemented');
    },
  });
  server.bind('0.0.0.0:8080', grpc.ServerCredentials.createInsecure());
  // tslint:disable-next-line:no-console
  console.log('About to start...');
  server.start();
}
