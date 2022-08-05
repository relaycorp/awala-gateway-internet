import * as grpc from '@grpc/grpc-js';
import { CogRPCClient, CogRPCError } from '@relaycorp/cogrpc';
import {
  Cargo,
  CargoCollectionAuthorization,
  Certificate,
  generateRSAKeyPair,
  issueGatewayCertificate,
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

import { expectBuffersToEqual } from '../testUtils/buffers';
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
    const parcelSerialized = await generateDummyParcel(pdaChain);
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

    const cargo = await Cargo.deserialize(bufferToArray(collectedCargoes[0]));
    expect(cargo.recipient.id).toEqual(await pdaChain.privateGatewayCert.calculateSubjectId());
    const { payload: cargoMessageSet } = await cargo.unwrapPayload(sessionPrivateKey);
    expect(cargoMessageSet.messages).toHaveLength(1);
    expectBuffersToEqual(cargoMessageSet.messages[0], parcelSerialized);
  });

  test('Cargo should be signed with Cargo Delivery Authorization', async () => {
    const { pdaChain, publicGatewaySessionKey } = await createAndRegisterPrivateGateway();
    await deliverParcel(GW_POHTTP_HOST_URL, await generateDummyParcel(pdaChain), {
      useTls: false,
    });
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
  const cargoSerialized = await encapsulateMessagesInCargo(
    [pingParcelData.parcelSerialized],
    pdaChain,
    publicGatewaySessionKey,
  );
  await asyncIterableToArray(
    cogRPCClient.deliverCargo(
      arrayToAsyncIterable([{ localId: 'random-delivery-id', cargo: cargoSerialized }]),
    ),
  );

  // Collect the pong message encapsulated in a cargo
  const cdaChain = await generateCDAChain(pdaChain);
  const { ccaSerialized, sessionPrivateKey } = await generateCCA(
    GW_INTERNET_ADDRESS,
    publicGatewaySessionKey,
    cdaChain.publicGatewayCert,
    pdaChain.privateGatewayCert,
    pdaChain.privateGatewayPrivateKey,
  );
  await waitForNextParcel(POWEB_CLIENT, pdaChain);
  const collectedCargoes = await asyncIterableToArray(cogRPCClient.collectCargo(ccaSerialized));
  expect(collectedCargoes).toHaveLength(1);
  const collectedMessages = await extractMessagesFromCargo(
    collectedCargoes[0],
    pdaChain.privateGatewayCert,
    sessionPrivateKey,
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

async function generateDummyParcel(pdaChain: ExternalPdaChain): Promise<ArrayBuffer> {
  const parcel = new Parcel(
    { id: await pdaChain.peerEndpointCert.calculateSubjectId() },
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
