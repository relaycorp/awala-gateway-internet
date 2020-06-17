import { CogRPCClient } from '@relaycorp/cogrpc';
import { Cargo } from '@relaycorp/relaynet-core';

import { asyncIterableToArray } from '../_test_utils';
import { configureServices } from './services';
import { generatePdaChain } from './utils';

const GW_GOGRPC_URL = 'http://127.0.0.1:8081';

configureServices('cogrpc');

describe('Cargo delivery', () => {
  test('Authorized cargo should be accepted', async () => {
    const pdaChain = await generatePdaChain();

    const cargo = new Cargo(GW_GOGRPC_URL, pdaChain.privateGatewayCertificate, Buffer.from([]));
    const cargoSerialized = Buffer.from(await cargo.serialize(pdaChain.privateGatewayPrivateKey));

    const cogRPCClient = await CogRPCClient.init(GW_GOGRPC_URL);
    const deliveryId = 'random-delivery-id';
    const ackDeliveryIds = await cogRPCClient.deliverCargo(
      arrayToIterable([{ localId: deliveryId, cargo: cargoSerialized }]),
    );

    await expect(asyncIterableToArray(ackDeliveryIds)).resolves.toEqual([deliveryId]);
  });

  test.todo('Unauthorized cargo should be refused');
});

describe('Cargo collection', () => {
  test.todo('Authorized CCA should be accepted');

  test.todo('Unauthorized CCA should be refused');
});

function* arrayToIterable<T>(array: readonly T[]): IterableIterator<T> {
  for (const item of array) {
    yield item;
  }
}
