// TODO: REMOVE ME

import { CogRPCClient } from '@relaycorp/relaynet-cogrpc';
import { CargoDeliveryRequest } from '@relaycorp/relaynet-core';

async function main(): Promise<void> {
  const client = new CogRPCClient('127.0.0.1:8081', false);

  for await (const localId of client.deliverCargo(generateCargo())) {
    // tslint:disable-next-line:no-console
    console.log('Delivery acknowledged:', localId);
    break;
  }
  client.close();
}

function* generateCargo(): IterableIterator<CargoDeliveryRequest> {
  yield { localId: 'the-original-id', cargo: Buffer.from('Hiya') };
}

main();
