import {
  Cargo,
  CargoMessageSet,
  InvalidMessageError,
  Parcel,
  ParcelCollectionAck,
  PrivateKeyStore,
  PrivateKeyStoreError,
  PublicKeyStore,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { get as getEnvVar } from 'env-var';
import pipe from 'it-pipe';
import { Connection } from 'mongoose';
import * as stan from 'node-nats-streaming';
import pino from 'pino';

import { createMongooseConnectionFromEnv } from '../backingServices/mongo';
import { NatsStreamingClient } from '../backingServices/natsStreaming';
import { ObjectStoreClient } from '../backingServices/objectStorage';
import { initVaultKeyStore } from '../backingServices/privateKeyStore';
import { MongoPublicKeyStore } from './MongoPublicKeyStore';
import { ParcelStore } from './parcelStore';

const LOGGER = pino();

export async function processIncomingCrcCargo(workerName: string): Promise<void> {
  const natsStreamingClient = NatsStreamingClient.initFromEnv(workerName);
  const privateKeyStore = initVaultKeyStore();

  const objectStoreClient = ObjectStoreClient.initFromEnv();
  const parcelStoreBucket = getEnvVar('OBJECT_STORE_BUCKET').required().asString();
  const parcelStore = new ParcelStore(objectStoreClient, parcelStoreBucket);

  const mongooseConnection = await createMongooseConnectionFromEnv();
  const publicKeyStore = new MongoPublicKeyStore(mongooseConnection);

  async function processCargo(messages: AsyncIterable<stan.Message>): Promise<void> {
    for await (const message of messages) {
      const cargo = await Cargo.deserialize(bufferToArray(message.getRawData()));
      const peerGatewayAddress = await cargo.senderCertificate.calculateSubjectPrivateAddress();
      // tslint:disable-next-line:no-let
      let cargoMessageSet: readonly ArrayBuffer[];
      try {
        cargoMessageSet = await unwrapCargo(cargo, privateKeyStore, publicKeyStore);
      } catch (err) {
        if (err instanceof PrivateKeyStoreError) {
          // Vault is down or returned an unexpected response
          throw err;
        }
        LOGGER.info(
          { cargoId: cargo.id, err, peerGatewayAddress, worker: workerName },
          'Cargo payload is invalid',
        );
        message.ack();
        continue;
      }

      for (const itemSerialized of cargoMessageSet) {
        // tslint:disable-next-line:no-let
        let item: Parcel | ParcelCollectionAck;
        try {
          item = await CargoMessageSet.deserializeItem(itemSerialized);
        } catch (error) {
          LOGGER.info(
            { cargoId: cargo.id, error, peerGatewayAddress, worker: workerName },
            'Cargo contains an invalid message',
          );
          continue;
        }
        if (item instanceof Parcel) {
          await processParcel(
            item,
            Buffer.from(itemSerialized),
            peerGatewayAddress,
            cargo.id,
            parcelStore,
            mongooseConnection,
            natsStreamingClient,
            workerName,
          );
        } else {
          await parcelStore.deleteGatewayBoundParcel(
            item.parcelId,
            item.senderEndpointPrivateAddress,
            item.recipientEndpointAddress,
            peerGatewayAddress,
          );
        }
      }

      // Take the cargo off the queue. No further processing is needed.
      message.ack();
    }
  }

  const queueConsumer = natsStreamingClient.makeQueueConsumer(
    'crc-cargo',
    'worker',
    'worker',
    undefined,
    '-consumer',
  );
  await pipe(queueConsumer, processCargo);
}

async function unwrapCargo(
  cargo: Cargo,
  privateKeyStore: PrivateKeyStore,
  publicKeyStore: PublicKeyStore,
): Promise<readonly ArrayBuffer[]> {
  const unwrapResult = await cargo.unwrapPayload(privateKeyStore);

  // If the sender uses channel session, store its public key for later use.
  if (unwrapResult.senderSessionKey) {
    await publicKeyStore.saveSessionKey(
      unwrapResult.senderSessionKey,
      cargo.senderCertificate,
      cargo.creationDate,
    );
  }

  return Array.from(unwrapResult.payload.messages);
}

async function processParcel(
  parcel: Parcel,
  parcelSerialized: Buffer,
  peerGatewayAddress: string,
  cargoId: string,
  parcelStore: ParcelStore,
  mongooseConnection: Connection,
  natsStreamingClient: NatsStreamingClient,
  workerName: string,
): Promise<void> {
  // tslint:disable-next-line:no-let
  let parcelObjectKey: string | null;
  try {
    parcelObjectKey = await parcelStore.storeParcelFromPeerGateway(
      parcel,
      parcelSerialized,
      peerGatewayAddress,
      mongooseConnection,
      natsStreamingClient,
      LOGGER,
    );
  } catch (err) {
    if (err instanceof InvalidMessageError) {
      LOGGER.info({ cargoId, err, peerGatewayAddress, worker: workerName }, 'Parcel is invalid');
      return;
    }

    throw err;
  }

  LOGGER.debug(
    {
      cargoId,
      parcelId: parcel.id,
      parcelObjectKey,
      parcelSenderAddress: await parcel.senderCertificate.calculateSubjectPrivateAddress(),
      peerGatewayAddress,
      worker: workerName,
    },
    parcelObjectKey ? 'Parcel was stored' : 'Ignoring previously processed parcel',
  );
}
