// tslint:disable:no-let
import { CogRPCClient, CogRPCError } from '@relaycorp/cogrpc';
import {
  Cargo,
  CargoCollectionAuthorization,
  generateRSAKeyPair,
  issueGatewayCertificate,
  Parcel,
} from '@relaycorp/relaynet-core';
import { deliverParcel } from '@relaycorp/relaynet-pohttp';
import bufferToArray from 'buffer-to-arraybuffer';
import { Message, Stan, Subscription } from 'node-nats-streaming';

import { asyncIterableToArray } from '../_test_utils';
import { GW_GOGRPC_URL, GW_POHTTP_URL } from './services';
import { arrayToIterable, connectToNatsStreaming, generatePdaChain, sleep } from './utils';

const TOMORROW = new Date();
TOMORROW.setDate(TOMORROW.getDate() + 1);

describe('Cargo delivery', () => {
  test('Authorized cargo should be accepted', async () => {
    const pdaChain = await generatePdaChain();
    const cargo = new Cargo(GW_GOGRPC_URL, pdaChain.privateGatewayCert, Buffer.from([]));
    const cargoSerialized = Buffer.from(await cargo.serialize(pdaChain.privateGatewayPrivateKey));

    const deliveryId = 'random-delivery-id';
    const cogRPCClient = await CogRPCClient.init(GW_GOGRPC_URL);
    try {
      const ackDeliveryIds = await cogRPCClient.deliverCargo(
        arrayToIterable([{ localId: deliveryId, cargo: cargoSerialized }]),
      );

      await expect(asyncIterableToArray(ackDeliveryIds)).resolves.toEqual([deliveryId]);
      await expect(getLastQueueMessage()).resolves.toEqual(cargoSerialized);
    } finally {
      cogRPCClient.close();
    }
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
    try {
      await asyncIterableToArray(
        await cogRPCClient.deliverCargo(
          arrayToIterable([{ localId: 'random-delivery-id', cargo: cargoSerialized }]),
        ),
      );
    } finally {
      cogRPCClient.close();
    }
    await expect(getLastQueueMessage()).resolves.not.toEqual(cargoSerialized);
  });
});

describe('Cargo collection', () => {
  test('Authorized CCA should be accepted', async () => {
    const pdaChain = await generatePdaChain();
    const parcel = new Parcel(
      await pdaChain.peerEndpointCert.calculateSubjectPrivateAddress(),
      pdaChain.pdaCert,
      Buffer.from([]),
      { senderCaCertificateChain: [pdaChain.peerEndpointCert, pdaChain.privateGatewayCert] },
    );
    const parcelSerialized = await parcel.serialize(pdaChain.pdaGranteePrivateKey);
    await deliverParcel(GW_POHTTP_URL, parcelSerialized);
    await sleep(1);

    const cca = new CargoCollectionAuthorization(
      GW_GOGRPC_URL,
      pdaChain.privateGatewayCert,
      Buffer.from([]),
    );
    const cogrpcClient = await CogRPCClient.init(GW_GOGRPC_URL);
    let collectedCargoes: readonly Buffer[];
    try {
      collectedCargoes = await asyncIterableToArray(
        cogrpcClient.collectCargo(
          Buffer.from(await cca.serialize(pdaChain.privateGatewayPrivateKey)),
        ),
      );
    } finally {
      cogrpcClient.close();
    }

    await expect(collectedCargoes).toHaveLength(1);

    const cargo = await Cargo.deserialize(bufferToArray(collectedCargoes[0]));
    expect(cargo.recipientAddress).toEqual(
      await pdaChain.privateGatewayCert.calculateSubjectPrivateAddress(),
    );
    const { payload: cargoMessageSet } = await cargo.unwrapPayload(
      pdaChain.privateGatewayPrivateKey,
    );
    await expect(Array.from(cargoMessageSet.messages)).toEqual([parcelSerialized]);
  });

  test('Unauthorized CCA should return zero cargoes', async () => {
    const unauthorizedSenderKeyPair = await generateRSAKeyPair();
    const unauthorizedCertificate = await issueGatewayCertificate({
      issuerPrivateKey: unauthorizedSenderKeyPair.privateKey,
      subjectPublicKey: unauthorizedSenderKeyPair.publicKey,
      validityEndDate: TOMORROW,
    });

    const cca = new CargoCollectionAuthorization(
      GW_GOGRPC_URL,
      unauthorizedCertificate,
      Buffer.from([]),
    );
    const ccaSerialized = Buffer.from(await cca.serialize(unauthorizedSenderKeyPair.privateKey));
    const cogrpcClient = await CogRPCClient.init(GW_GOGRPC_URL);
    try {
      await expect(
        asyncIterableToArray(cogrpcClient.collectCargo(ccaSerialized)),
      ).resolves.toHaveLength(0);
    } finally {
      cogrpcClient.close();
    }
  });

  test('CCAs should not be reusable', async () => {
    const pdaChain = await generatePdaChain();
    const cca = new CargoCollectionAuthorization(
      GW_GOGRPC_URL,
      pdaChain.privateGatewayCert,
      Buffer.from([]),
    );
    const ccaSerialized = Buffer.from(await cca.serialize(pdaChain.privateGatewayPrivateKey));

    const cogrpcClient = await CogRPCClient.init(GW_GOGRPC_URL);
    try {
      await expect(asyncIterableToArray(cogrpcClient.collectCargo(ccaSerialized))).toResolve();
      await expect(
        asyncIterableToArray(cogrpcClient.collectCargo(ccaSerialized)),
      ).rejects.toBeInstanceOf(CogRPCError);
    } finally {
      cogrpcClient.close();
    }
  });
});

async function getLastQueueMessage(): Promise<Buffer | undefined> {
  const stanConnection = await connectToNatsStreaming();
  const subscription = subscribeToCRCChannel(stanConnection);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.close();
      stanConnection.close();
      resolve();
    }, 3_000);
    subscription.on('error', (error) => {
      clearTimeout(timeout);
      // Close the connection directly. Not the subscription because it probably wasn't created.
      stanConnection.close();
      reject(error);
    });
    subscription.on('message', (message: Message) => {
      clearTimeout(timeout);
      subscription.close();
      stanConnection.close();
      resolve(message.getRawData());
    });
  });
}

function subscribeToCRCChannel(stanConnection: Stan): Subscription {
  return stanConnection.subscribe(
    'crc-cargo',
    'functional-tests',
    stanConnection.subscriptionOptions().setDeliverAllAvailable().setStartWithLastReceived(),
  );
}
