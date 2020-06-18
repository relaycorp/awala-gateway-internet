// tslint:disable:no-let
import { CogRPCClient } from '@relaycorp/cogrpc';
import {
  Cargo,
  Certificate,
  generateRSAKeyPair,
  issueGatewayCertificate,
} from '@relaycorp/relaynet-core';

import { asyncIterableToArray } from '../_test_utils';
import { configureServices } from './services';
import { generatePdaChain, getFirstQueueMessage } from './utils';

const GW_GOGRPC_URL = 'http://127.0.0.1:8081';

const TOMORROW = new Date();
TOMORROW.setDate(TOMORROW.getDate() + 1);

configureServices('cogrpc');

let PRIVATE_GATEWAY_PRIVATE_KEY: CryptoKey;
let PRIVATE_GATEWAY_CERTIFICATE: Certificate;
beforeEach(async () => {
  const pdaChain = await generatePdaChain();
  PRIVATE_GATEWAY_PRIVATE_KEY = pdaChain.privateGatewayPrivateKey;
  PRIVATE_GATEWAY_CERTIFICATE = pdaChain.privateGatewayCert;
});

describe('Cargo delivery', () => {
  test('Authorized cargo should be accepted', async () => {
    const cargo = new Cargo(GW_GOGRPC_URL, PRIVATE_GATEWAY_CERTIFICATE, Buffer.from([]));
    const cargoSerialized = Buffer.from(await cargo.serialize(PRIVATE_GATEWAY_PRIVATE_KEY));

    const cogRPCClient = await CogRPCClient.init(GW_GOGRPC_URL);
    const deliveryId = 'random-delivery-id';
    const ackDeliveryIds = await cogRPCClient.deliverCargo(
      arrayToIterable([{ localId: deliveryId, cargo: cargoSerialized }]),
    );

    await expect(asyncIterableToArray(ackDeliveryIds)).resolves.toEqual([deliveryId]);
    await expect(getFirstQueueMessage('crc-cargo')).resolves.toEqual(cargoSerialized);
  });

  test('Unauthorized cargo should be acknowledged but not processed', async () => {
    const unauthorizedSenderKeyPair = await generateRSAKeyPair();
    const unauthorizedCertificate = await issueGatewayCertificate({
      issuerPrivateKey: unauthorizedSenderKeyPair.privateKey,
      subjectPublicKey: unauthorizedSenderKeyPair.publicKey,
      validityEndDate: TOMORROW,
    });

    const cargo = new Cargo(GW_GOGRPC_URL, unauthorizedCertificate, Buffer.from([]));
    const cargoSerialized = Buffer.from(
      await cargo.serialize(unauthorizedSenderKeyPair.privateKey),
    );

    const cogRPCClient = await CogRPCClient.init(GW_GOGRPC_URL);
    await expect(
      asyncIterableToArray(
        await cogRPCClient.deliverCargo(
          arrayToIterable([{ localId: 'random-delivery-id', cargo: cargoSerialized }]),
        ),
      ),
    ).toResolve();
    await expect(getFirstQueueMessage('crc-cargo')).resolves.toBeUndefined();
  });
});

describe('Cargo collection', () => {
  test.todo('Authorized CCA should be accepted');

  test.todo('Unauthorized CCA should be refused');

  test.todo('CCAs should not be reusable');
});

function* arrayToIterable<T>(array: readonly T[]): IterableIterator<T> {
  for (const item of array) {
    yield item;
  }
}
