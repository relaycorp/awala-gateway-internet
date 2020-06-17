import { CogRPCClient } from '@relaycorp/cogrpc';
import { Cargo, generateRSAKeyPair, issueGatewayCertificate } from '@relaycorp/relaynet-core';
import { Message, Stan } from 'node-nats-streaming';

import { asyncIterableToArray } from '../_test_utils';
import { configureServices } from './services';
import { connectToNatsStreaming, generatePdaChain } from './utils';

const GW_GOGRPC_URL = 'http://127.0.0.1:8081';

const TOMORROW = new Date();
TOMORROW.setDate(TOMORROW.getDate() + 1);

configureServices('cogrpc');
// tslint:disable-next-line:no-let
let stanConnection: Stan;
beforeEach(async () => (stanConnection = await connectToNatsStreaming()));
afterEach(async () => stanConnection.close());

describe('Cargo delivery', () => {
  test('Authorized cargo should be accepted', async () => {
    const pdaChain = await generatePdaChain();

    const cargo = new Cargo(GW_GOGRPC_URL, pdaChain.privateGatewayCertificate, Buffer.from([1]));
    const cargoSerialized = Buffer.from(await cargo.serialize(pdaChain.privateGatewayPrivateKey));

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
});

function* arrayToIterable<T>(array: readonly T[]): IterableIterator<T> {
  for (const item of array) {
    yield item;
  }
}

async function getFirstQueueMessage(subject: string): Promise<Buffer | undefined> {
  const subscription = stanConnection.subscribe(
    subject,
    'functional-tests',
    stanConnection.subscriptionOptions().setDeliverAllAvailable(),
  );
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.close();
      resolve();
    }, 3_000);
    subscription.on('error', error => {
      clearTimeout(timeout);
      subscription.close();
      reject(error);
    });
    subscription.on('message', (message: Message) => {
      clearTimeout(timeout);
      resolve(message.getRawData());
    });
  });
}
