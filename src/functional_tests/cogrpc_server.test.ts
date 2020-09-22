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

import { asyncIterableToArray } from '../_test_utils';
import { configureServices, GW_GOGRPC_URL, GW_POHTTP_URL } from './services';
import { arrayToIterable, generatePdaChain, getFirstQueueMessage, sleep } from './utils';

const TOMORROW = new Date();
TOMORROW.setDate(TOMORROW.getDate() + 1);

configureServices(['cogrpc', 'vault']);

describe('Cargo delivery', () => {
  test('Authorized cargo should be accepted', async () => {
    const pdaChain = await generatePdaChain();
    const cargo = new Cargo(GW_GOGRPC_URL, pdaChain.privateGatewayCert, Buffer.from([]));
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
    await asyncIterableToArray(
      await cogRPCClient.deliverCargo(
        arrayToIterable([{ localId: 'random-delivery-id', cargo: cargoSerialized }]),
      ),
    );
    await expect(getFirstQueueMessage('crc-cargo')).resolves.toBeUndefined();
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
    const collectedCargoes = await asyncIterableToArray(
      cogrpcClient.collectCargo(
        Buffer.from(await cca.serialize(pdaChain.privateGatewayPrivateKey)),
      ),
    );

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
    await expect(
      asyncIterableToArray(cogrpcClient.collectCargo(ccaSerialized)),
    ).resolves.toHaveLength(0);
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
    await expect(asyncIterableToArray(cogrpcClient.collectCargo(ccaSerialized))).toResolve();
    await expect(
      asyncIterableToArray(cogrpcClient.collectCargo(ccaSerialized)),
    ).rejects.toBeInstanceOf(CogRPCError);
  });
});
