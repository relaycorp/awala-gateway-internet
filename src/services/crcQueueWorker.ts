import {
  Cargo,
  CargoMessageSet,
  Gateway,
  InvalidMessageError,
  Parcel,
  ParcelCollectionAck,
  PrivateKeyStoreError,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { get as getEnvVar } from 'env-var';
import pipe from 'it-pipe';
import { Connection } from 'mongoose';
import * as stan from 'node-nats-streaming';
import pino from 'pino';

import { initVaultKeyStore } from '../backingServices/keyStores';
import { createMongooseConnectionFromEnv } from '../backingServices/mongo';
import { NatsStreamingClient } from '../backingServices/natsStreaming';
import { initObjectStoreFromEnv } from '../backingServices/objectStorage';
import { MongoPublicKeyStore } from './MongoPublicKeyStore';
import { ParcelStore } from './parcelStore';

const LOGGER = pino();

export async function processIncomingCrcCargo(workerName: string): Promise<void> {
  const natsStreamingClient = NatsStreamingClient.initFromEnv(workerName);

  const mongooseConnection = await createMongooseConnectionFromEnv();
  const gateway = new Gateway(initVaultKeyStore(), new MongoPublicKeyStore(mongooseConnection));

  const objectStoreClient = initObjectStoreFromEnv();
  const parcelStoreBucket = getEnvVar('OBJECT_STORE_BUCKET').required().asString();
  const parcelStore = new ParcelStore(objectStoreClient, parcelStoreBucket);

  async function processCargo(messages: AsyncIterable<stan.Message>): Promise<void> {
    for await (const message of messages) {
      const cargo = await Cargo.deserialize(bufferToArray(message.getRawData()));
      const peerGatewayAddress = await cargo.senderCertificate.calculateSubjectPrivateAddress();
      let cargoMessageSet: CargoMessageSet;
      try {
        cargoMessageSet = await gateway.unwrapMessagePayload(cargo);
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

      for (const itemSerialized of cargoMessageSet.messages) {
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
