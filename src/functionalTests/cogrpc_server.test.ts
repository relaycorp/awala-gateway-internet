import * as grpc from '@grpc/grpc-js';
import { CogRPCClient, CogRPCError } from '@relaycorp/cogrpc';
import {
  Cargo,
  CargoCollectionAuthorization,
  generateRSAKeyPair,
  issueGatewayCertificate,
  Parcel,
  RecipientAddressType,
} from '@relaycorp/relaynet-core';
import { deliverParcel } from '@relaycorp/relaynet-pohttp';
import bufferToArray from 'buffer-to-arraybuffer';
import { addDays } from 'date-fns';
import { Message, Stan, Subscription } from 'node-nats-streaming';

import {
  arrayToAsyncIterable,
  asyncIterableToArray,
  ExternalPdaChain,
  generateCCA,
  generateCDAChain,
  getPromiseRejection,
} from '../_test_utils';
import { expectBuffersToEqual } from '../services/_test_utils';
import { GW_COGRPC_URL, GW_POHTTP_URL, GW_PUBLIC_ADDRESS_URL } from './services';
import { connectToNatsStreaming, createAndRegisterPrivateGateway, sleep } from './utils';

const TOMORROW = addDays(new Date(), 1);

let cogRPCClient: CogRPCClient;
beforeEach(async () => {
  cogRPCClient = await CogRPCClient.init(GW_COGRPC_URL);
});
afterEach(() => {
  cogRPCClient.close();
});

describe('Cargo delivery', () => {
  test('Authorized cargo should be accepted', async () => {
    const { pdaChain } = await createAndRegisterPrivateGateway();
    const cargo = new Cargo(GW_PUBLIC_ADDRESS_URL, pdaChain.privateGatewayCert, Buffer.from([]));
    const cargoSerialized = Buffer.from(await cargo.serialize(pdaChain.privateGatewayPrivateKey));

    const deliveryId = 'random-delivery-id';
    const ackDeliveryIds = await cogRPCClient.deliverCargo(
      arrayToAsyncIterable([{ localId: deliveryId, cargo: cargoSerialized }]),
    );

    await expect(asyncIterableToArray(ackDeliveryIds)).resolves.toEqual([deliveryId]);
    await expect(getLastQueueMessage()).resolves.toEqual(cargoSerialized);
  });

  test('Unauthorized cargo should be acknowledged but not processed', async () => {
    const unauthorizedSenderKeyPair = await generateRSAKeyPair();
    const unauthorizedCertificate = await issueGatewayCertificate({
      issuerPrivateKey: unauthorizedSenderKeyPair.privateKey,
      subjectPublicKey: unauthorizedSenderKeyPair.publicKey,
      validityEndDate: TOMORROW,
    });

    const cargo = new Cargo(GW_PUBLIC_ADDRESS_URL, unauthorizedCertificate, Buffer.from([]));
    const cargoSerialized = Buffer.from(
      await cargo.serialize(unauthorizedSenderKeyPair.privateKey),
    );

    await asyncIterableToArray(
      await cogRPCClient.deliverCargo(
        arrayToAsyncIterable([{ localId: 'random-delivery-id', cargo: cargoSerialized }]),
      ),
    );

    await expect(getLastQueueMessage()).resolves.not.toEqual(cargoSerialized);
  });
});

describe('Cargo collection', () => {
  test('Authorized CCA should be accepted', async () => {
    const { pdaChain, publicGatewaySessionKey } = await createAndRegisterPrivateGateway();
    const parcelSerialized = await generateDummyParcel(pdaChain);
    await deliverParcel(GW_POHTTP_URL, parcelSerialized);

    await sleep(1);

    const cdaChain = await generateCDAChain(pdaChain);
    const { ccaSerialized, sessionPrivateKey } = await generateCCA(
      GW_PUBLIC_ADDRESS_URL,
      publicGatewaySessionKey,
      cdaChain.publicGatewayCert,
      pdaChain.privateGatewayCert,
      pdaChain.privateGatewayPrivateKey,
    );
    const collectedCargoes = await asyncIterableToArray(cogRPCClient.collectCargo(ccaSerialized));

    await expect(collectedCargoes).toHaveLength(1);

    const cargo = await Cargo.deserialize(bufferToArray(collectedCargoes[0]));
    expect(cargo.recipientAddress).toEqual(
      await pdaChain.privateGatewayCert.calculateSubjectPrivateAddress(),
    );
    const { payload: cargoMessageSet } = await cargo.unwrapPayload(sessionPrivateKey);
    expect(cargoMessageSet.messages).toHaveLength(1);
    expectBuffersToEqual(cargoMessageSet.messages[0], parcelSerialized);
  });

  test('Cargo should be signed with Cargo Delivery Authorization', async () => {
    const { pdaChain, publicGatewaySessionKey } = await createAndRegisterPrivateGateway();
    await deliverParcel(GW_POHTTP_URL, await generateDummyParcel(pdaChain));

    await sleep(1);

    const cdaChain = await generateCDAChain(pdaChain);
    const { ccaSerialized } = await generateCCA(
      GW_PUBLIC_ADDRESS_URL,
      publicGatewaySessionKey,
      cdaChain.publicGatewayCert,
      pdaChain.privateGatewayCert,
      pdaChain.privateGatewayPrivateKey,
    );
    const collectedCargoes = await asyncIterableToArray(cogRPCClient.collectCargo(ccaSerialized));

    const cargo = await Cargo.deserialize(bufferToArray(collectedCargoes[0]));
    await cargo.validate(RecipientAddressType.PRIVATE, [cdaChain.privateGatewayCert]);
  });

  test('Unauthorized CCA should be refused', async () => {
    const unauthorizedSenderKeyPair = await generateRSAKeyPair();
    const unauthorizedCertificate = await issueGatewayCertificate({
      issuerPrivateKey: unauthorizedSenderKeyPair.privateKey,
      subjectPublicKey: unauthorizedSenderKeyPair.publicKey,
      validityEndDate: TOMORROW,
    });
    const cca = new CargoCollectionAuthorization(
      GW_PUBLIC_ADDRESS_URL,
      unauthorizedCertificate,
      Buffer.from([]),
    );
    const ccaSerialized = Buffer.from(await cca.serialize(unauthorizedSenderKeyPair.privateKey));

    const error = await getPromiseRejection<CogRPCError>(
      asyncIterableToArray(cogRPCClient.collectCargo(ccaSerialized)),
    );

    expect(error.cause()).toHaveProperty('code', grpc.status.UNAUTHENTICATED);
  });

  test('CCAs should not be reusable', async () => {
    const { pdaChain, publicGatewaySessionKey } = await createAndRegisterPrivateGateway();
    const cdaChain = await generateCDAChain(pdaChain);
    const { ccaSerialized } = await generateCCA(
      GW_PUBLIC_ADDRESS_URL,
      publicGatewaySessionKey,
      cdaChain.publicGatewayCert,
      pdaChain.privateGatewayCert,
      pdaChain.privateGatewayPrivateKey,
    );
    await expect(asyncIterableToArray(cogRPCClient.collectCargo(ccaSerialized))).toResolve();

    const error = await getPromiseRejection<CogRPCError>(
      asyncIterableToArray(cogRPCClient.collectCargo(ccaSerialized)),
    );

    expect(error.cause()).toHaveProperty('code', grpc.status.PERMISSION_DENIED);
  });
});

async function generateDummyParcel(pdaChain: ExternalPdaChain): Promise<ArrayBuffer> {
  const parcel = new Parcel(
    await pdaChain.peerEndpointCert.calculateSubjectPrivateAddress(),
    pdaChain.pdaCert,
    Buffer.from([]),
    { senderCaCertificateChain: [pdaChain.peerEndpointCert, pdaChain.privateGatewayCert] },
  );
  return parcel.serialize(pdaChain.pdaGranteePrivateKey);
}

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
