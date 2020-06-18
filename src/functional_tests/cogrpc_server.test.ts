// tslint:disable:no-let
import { CogRPCClient, CogRPCError } from '@relaycorp/cogrpc';
import {
  Cargo,
  CargoCollectionAuthorization,
  generateRSAKeyPair,
  issueGatewayCertificate,
  Parcel,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';

import { asyncIterableToArray, PdaChain } from '../_test_utils';
import { ObjectStoreClient } from '../backingServices/objectStorage';
import { ParcelStore } from '../services/parcelStore';
import { configureServices } from './services';
import { generatePdaChain, getFirstQueueMessage, OBJECT_STORAGE_BUCKET } from './utils';

const GW_GOGRPC_URL = 'http://127.0.0.1:8081/';

const TOMORROW = new Date();
TOMORROW.setDate(TOMORROW.getDate() + 1);

configureServices('cogrpc');

let PDA_CHAIN: PdaChain;
beforeEach(async () => {
  PDA_CHAIN = await generatePdaChain();
});

describe('Cargo delivery', () => {
  test('Authorized cargo should be accepted', async () => {
    const cargo = new Cargo(GW_GOGRPC_URL, PDA_CHAIN.privateGatewayCert, Buffer.from([]));
    const cargoSerialized = Buffer.from(await cargo.serialize(PDA_CHAIN.privateGatewayPrivateKey));

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
  test('Authorized CCA should be accepted', async () => {
    const parcel = new Parcel(
      await PDA_CHAIN.peerEndpointCert.calculateSubjectPrivateAddress(),
      PDA_CHAIN.pdaCert,
      Buffer.from([]),
    );
    const parcelSerialized = await parcel.serialize(PDA_CHAIN.pdaGranteePrivateKey);
    const parcelStore = new ParcelStore(ObjectStoreClient.initFromEnv(), OBJECT_STORAGE_BUCKET);
    await parcelStore.storeGatewayBoundParcel(
      parcel,
      Buffer.from(parcelSerialized),
      await PDA_CHAIN.privateGatewayCert.calculateSubjectPrivateAddress(),
    );

    const cca = new CargoCollectionAuthorization(
      GW_GOGRPC_URL,
      PDA_CHAIN.privateGatewayCert,
      Buffer.from([]),
    );
    const cogrpcClient = await CogRPCClient.init(GW_GOGRPC_URL);
    const collectedCargoes = await asyncIterableToArray(
      cogrpcClient.collectCargo(
        Buffer.from(await cca.serialize(PDA_CHAIN.privateGatewayPrivateKey)),
      ),
    );

    await expect(collectedCargoes).toHaveLength(1);

    const cargo = await Cargo.deserialize(bufferToArray(collectedCargoes[0]));
    expect(cargo.recipientAddress).toEqual(
      await PDA_CHAIN.privateGatewayCert.calculateSubjectPrivateAddress(),
    );
    const { payload: cargoMessageSet } = await cargo.unwrapPayload(
      PDA_CHAIN.privateGatewayPrivateKey,
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
    const cca = new CargoCollectionAuthorization(
      GW_GOGRPC_URL,
      PDA_CHAIN.privateGatewayCert,
      Buffer.from([]),
    );
    const ccaSerialized = Buffer.from(await cca.serialize(PDA_CHAIN.privateGatewayPrivateKey));

    const cogrpcClient = await CogRPCClient.init(GW_GOGRPC_URL);
    await expect(asyncIterableToArray(cogrpcClient.collectCargo(ccaSerialized))).toResolve();
    await expect(
      asyncIterableToArray(cogrpcClient.collectCargo(ccaSerialized)),
    ).rejects.toBeInstanceOf(CogRPCError);
  });
});

function* arrayToIterable<T>(array: readonly T[]): IterableIterator<T> {
  for (const item of array) {
    yield item;
  }
}
