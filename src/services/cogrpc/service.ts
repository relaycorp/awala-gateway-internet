import { CargoDelivery, CargoDeliveryAck } from '@relaycorp/relaynet-cogrpc';
import * as grpc from 'grpc';

export function deliverCargo(
  _call: grpc.ServerDuplexStream<CargoDelivery, CargoDeliveryAck>,
): void {
  // call.on('data', (delivery: CargoDelivery): void => {
  //   // tslint:disable-next-line:no-console
  //   console.log('Received cargo', { delivery });
  //   const ack: CargoDeliveryAck = { id: delivery.id };
  //   call.write(ack); // ACK
  // });
  //
  // call.on('end', () => {
  //   // tslint:disable-next-line:no-console
  //   console.log('Call ended');
  //   call.end();
  // });
  throw new Error('Unimplemented');
}

export async function collectCargo(
  _call: grpc.ServerDuplexStream<CargoDeliveryAck, CargoDelivery>,
): Promise<void> {
  throw new Error('Unimplemented');
}
