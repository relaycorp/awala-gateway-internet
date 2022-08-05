import * as grpc from '@grpc/grpc-js';
import { CogRPCClient, CogRPCError } from '@relaycorp/cogrpc';
import {
  Cargo,
  CargoCollectionAuthorization,
  Certificate,
  generateRSAKeyPair,
  issueGatewayCertificate,
  MockPrivateKeyStore,
  Parcel,
  ParcelCollectionAck,
  Recipient,
} from '@relaycorp/relaynet-core';
import { deliverParcel } from '@relaycorp/relaynet-pohttp';
import { PoWebClient } from '@relaycorp/relaynet-poweb';
import bufferToArray from 'buffer-to-arraybuffer';
import { addDays } from 'date-fns';
import { Message, Stan, Subscription } from 'node-nats-streaming';
import uuid from 'uuid-random';
import { GeneratedParcel } from '../testUtils/awala';

import { arrayToAsyncIterable, asyncIterableToArray } from '../testUtils/iter';
import { getPromiseRejection } from '../testUtils/jest';
import { ExternalPdaChain, generateCCA, generateCDAChain } from '../testUtils/pki';
import { encapsulateMessagesInCargo, extractMessagesFromCargo } from './utils/cargo';
import { createAndRegisterPrivateGateway } from './utils/gatewayRegistration';
import {
  GW_COGRPC_HOST,
  GW_INTERNET_ADDRESS,
  GW_POHTTP_HOST_URL,
  GW_POWEB_HOST_PORT,
} from './utils/constants';
import { connectToNatsStreaming } from './utils/nats';
import { extractPong, makePingParcel } from './utils/ping';
import { waitForNextParcel } from './utils/poweb';

const TOMORROW = addDays(new Date(), 1);

const POWEB_CLIENT = PoWebClient.initLocal(GW_POWEB_HOST_PORT);

let cogRPCClient: CogRPCClient;
beforeEach(async () => {
  cogRPCClient = await CogRPCClient.initLan(GW_COGRPC_HOST);
});
afterEach(() => {
  cogRPCClient.close();
});

describe('Cargo delivery', () => {
  test('Authorized cargo should be accepted', async () => {
    const { pdaChain } = await createAndRegisterPrivateGateway();
    const cargo = new Cargo(
      await getPublicGatewayRecipient(pdaChain.publicGatewayCert),
      pdaChain.privateGatewayCert,
      Buffer.from([]),
    );
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

    const cargo = new Cargo(
      await getPublicGatewayRecipient(unauthorizedCertificate),
      unauthorizedCertificate,
      Buffer.from([]),
    );
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
    const { parcel, parcelSerialized } = await generateDummyParcel(pdaChain);
    await deliverParcel(GW_POHTTP_HOST_URL, parcelSerialized, { useTls: false });
    await waitForNextParcel(POWEB_CLIENT, pdaChain);

    const cdaChain = await generateCDAChain(pdaChain);
    const { ccaSerialized, sessionPrivateKey } = await generateCCA(
      GW_INTERNET_ADDRESS,
      publicGatewaySessionKey,
      cdaChain.publicGatewayCert,
      pdaChain.privateGatewayCert,
      pdaChain.privateGatewayPrivateKey,
    );
    const collectedCargoes = await asyncIterableToArray(cogRPCClient.collectCargo(ccaSerialized));

    await expect(collectedCargoes).toHaveLength(1);
    const cargoMessages = await extractMessagesFromCargo(
      collectedCargoes[0],
      cdaChain.privateGatewayCert,
      sessionPrivateKey,
    );
    expect(cargoMessages).toHaveLength(1);
    expect(cargoMessages[0]).toBeInstanceOf(Parcel);
    expect((cargoMessages[0] as Parcel).id).toEqual(parcel.id);
  });

  test('Cargo should be signed with Cargo Delivery Authorization', async () => {
    const { pdaChain, publicGatewaySessionKey } = await createAndRegisterPrivateGateway();
    const { parcelSerialized } = await generateDummyParcel(pdaChain);
    await deliverParcel(GW_POHTTP_HOST_URL, parcelSerialized, { useTls: false });
    await waitForNextParcel(POWEB_CLIENT, pdaChain);

    const cdaChain = await generateCDAChain(pdaChain);
    const { ccaSerialized } = await generateCCA(
      GW_INTERNET_ADDRESS,
      publicGatewaySessionKey,
      cdaChain.publicGatewayCert,
      pdaChain.privateGatewayCert,
      pdaChain.privateGatewayPrivateKey,
    );
    const collectedCargoes = await asyncIterableToArray(cogRPCClient.collectCargo(ccaSerialized));

    const cargo = await Cargo.deserialize(bufferToArray(collectedCargoes[0]));
    await cargo.validate([cdaChain.privateGatewayCert]);
  });

  test('Unauthorized CCA should be refused', async () => {
    const unauthorizedSenderKeyPair = await generateRSAKeyPair();
    const unauthorizedCertificate = await issueGatewayCertificate({
      issuerPrivateKey: unauthorizedSenderKeyPair.privateKey,
      subjectPublicKey: unauthorizedSenderKeyPair.publicKey,
      validityEndDate: TOMORROW,
    });
    const cca = new CargoCollectionAuthorization(
      await getPublicGatewayRecipient(unauthorizedCertificate),
      unauthorizedCertificate,
      Buffer.from([]),
    );
    const ccaSerialized = Buffer.from(await cca.serialize(unauthorizedSenderKeyPair.privateKey));

    const error = await getPromiseRejection(
      asyncIterableToArray(cogRPCClient.collectCargo(ccaSerialized)),
      CogRPCError,
    );

    expect(error.cause()).toHaveProperty('code', grpc.status.UNAUTHENTICATED);
  });

  test('CCAs should not be reusable', async () => {
    const { pdaChain, publicGatewaySessionKey } = await createAndRegisterPrivateGateway();
    const cdaChain = await generateCDAChain(pdaChain);
    const { ccaSerialized } = await generateCCA(
      GW_INTERNET_ADDRESS,
      publicGatewaySessionKey,
      cdaChain.publicGatewayCert,
      pdaChain.privateGatewayCert,
      pdaChain.privateGatewayPrivateKey,
    );
    await expect(asyncIterableToArray(cogRPCClient.collectCargo(ccaSerialized))).toResolve();

    const error = await getPromiseRejection(
      asyncIterableToArray(cogRPCClient.collectCargo(ccaSerialized)),
      CogRPCError,
    );

    expect(error.cause()).toHaveProperty('code', grpc.status.PERMISSION_DENIED);
  });
});

test('Sending pings and receiving pongs', async () => {
  const { pdaChain, publicGatewaySessionKey } = await createAndRegisterPrivateGateway();

  const pingId = uuid();
  const pingParcelData = await makePingParcel(pingId, pdaChain);

  // Deliver the ping message encapsulated in a cargo
  const privateGatewayKeyStore = new MockPrivateKeyStore();
  const cargoSerialized = await encapsulateMessagesInCargo(
    [pingParcelData.parcelSerialized],
    pdaChain,
    publicGatewaySessionKey,
    privateGatewayKeyStore,
  );
  await asyncIterableToArray(
    cogRPCClient.deliverCargo(
      arrayToAsyncIterable([{ localId: 'random-delivery-id', cargo: cargoSerialized }]),
    ),
  );
  await waitForNextParcel(POWEB_CLIENT, pdaChain);

  // Collect the pong message encapsulated in a cargo
  const cdaChain = await generateCDAChain(pdaChain);
  const { ccaSerialized } = await generateCCA(
    GW_INTERNET_ADDRESS,
    publicGatewaySessionKey,
    cdaChain.publicGatewayCert,
    pdaChain.privateGatewayCert,
    pdaChain.privateGatewayPrivateKey,
    privateGatewayKeyStore,
  );
  const collectedCargoes = await asyncIterableToArray(cogRPCClient.collectCargo(ccaSerialized));
  expect(collectedCargoes).toHaveLength(1);
  const collectedMessages = await extractMessagesFromCargo(
    collectedCargoes[0],
    cdaChain.privateGatewayCert,
    privateGatewayKeyStore,
  );
  expect(collectedMessages).toHaveLength(2);
  const collectionAck = collectedMessages[0];
  expect(collectionAck).toBeInstanceOf(ParcelCollectionAck);
  expect(collectionAck).toHaveProperty('parcelId', pingParcelData.parcelId);
  const pongParcel = collectedMessages[1];
  expect(pongParcel).toBeInstanceOf(Parcel);
  await expect(extractPong(pongParcel as Parcel, pingParcelData.sessionKey)).resolves.toEqual(
    pingId,
  );
});

async function getPublicGatewayRecipient(
  publicGatewayCertificate: Certificate,
): Promise<Recipient> {
  return { id: await publicGatewayCertificate.calculateSubjectId() };
}

async function generateDummyParcel(pdaChain: ExternalPdaChain): Promise<GeneratedParcel> {
  const parcel = new Parcel(
    { id: await pdaChain.peerEndpointCert.calculateSubjectId() },
    pdaChain.pdaCert,
    Buffer.from([]),
    { senderCaCertificateChain: [pdaChain.peerEndpointCert, pdaChain.privateGatewayCert] },
  );
  const parcelSerialized = await parcel.serialize(pdaChain.pdaGranteePrivateKey);
  return { parcel, parcelSerialized };
}

async function getLastQueueMessage(): Promise<Buffer | undefined> {
  const stanConnection = await connectToNatsStreaming();
  const subscription = subscribeToCRCChannel(stanConnection);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.close();
      stanConnection.close();
      reject(new Error('Could not get NATS Streaming message on time'));
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
