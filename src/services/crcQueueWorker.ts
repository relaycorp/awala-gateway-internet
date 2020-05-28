import {
  Cargo,
  CargoMessageSet,
  OriginatorSessionKey,
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

import { createMongooseConnectionFromEnv } from '../backingServices/mongo';
import { NatsStreamingClient } from '../backingServices/natsStreaming';
import { ObjectStoreClient } from '../backingServices/objectStorage';
import { initVaultKeyStore } from '../backingServices/privateKeyStore';
import { MongoPublicKeyStore } from './MongoPublicKeyStore';
import { recordParcelCollection, wasParcelCollected } from './parcelCollection';
import { ParcelStore } from './parcelStore';

const logger = pino();

export async function processIncomingCrcCargo(workerName: string): Promise<void> {
  const natsStreamingClient = NatsStreamingClient.initFromEnv(workerName);
  const privateKeyStore = initVaultKeyStore();

  const objectStoreClient = ObjectStoreClient.initFromEnv();
  const parcelStoreBucket = getEnvVar('PARCEL_STORE_BUCKET')
    .required()
    .asString();
  const parcelStore = new ParcelStore(objectStoreClient, parcelStoreBucket);

  const mongooseConnection = await createMongooseConnectionFromEnv();
  const publicKeyStore = new MongoPublicKeyStore(mongooseConnection);

  async function processCargo(messages: AsyncIterable<stan.Message>): Promise<void> {
    for await (const message of messages) {
      const cargo = await Cargo.deserialize(bufferToArray(message.getRawData()));
      // tslint:disable-next-line:no-let
      let unwrapResult: {
        readonly payload: CargoMessageSet;
        readonly senderSessionKey?: OriginatorSessionKey;
      };
      const peerGatewayAddress = await cargo.senderCertificate.calculateSubjectPrivateAddress();
      try {
        unwrapResult = await cargo.unwrapPayload(privateKeyStore);
      } catch (err) {
        if (err instanceof PrivateKeyStoreError) {
          // Vault is down or returned an unexpected response
          throw err;
        }
        logger.info(
          { cargoId: cargo.id, err, peerGatewayAddress, worker: workerName },
          'Cargo payload is invalid',
        );
        message.ack();
        continue;
      }

      // If the sender uses channel session, store its public key for later use.
      if (unwrapResult.senderSessionKey) {
        await publicKeyStore.saveSessionKey(
          unwrapResult.senderSessionKey,
          cargo.senderCertificate,
          cargo.creationDate,
        );
      }

      for (const itemSerialized of unwrapResult.payload.messages) {
        // tslint:disable-next-line:no-let
        let item: Parcel | ParcelCollectionAck;
        try {
          item = await CargoMessageSet.deserializeItem(itemSerialized);
        } catch (error) {
          logger.info(
            { cargoId: cargo.id, error, peerGatewayAddress, worker: workerName },
            'Cargo contains an invalid message',
          );
          continue;
        }
        if (item instanceof Parcel) {
          await processParcel(
            item,
            itemSerialized,
            cargo,
            mongooseConnection,
            natsStreamingClient,
            workerName,
          );
        } else {
          await processPca(item, peerGatewayAddress, parcelStore, cargo.id, workerName);
        }
      }
      message.ack();
    }
  }

  const queueConsumer = natsStreamingClient.makeQueueConsumer('crc-cargo', 'worker', 'worker');
  try {
    await pipe(queueConsumer, processCargo);
  } finally {
    natsStreamingClient.disconnect();
  }
}

async function processParcel(
  parcel: Parcel,
  parcelSerialized: ArrayBuffer,
  cargo: Cargo,
  mongooseConnection: Connection,
  natsStreamingClient: NatsStreamingClient,
  workerName: string,
): Promise<void> {
  const peerGatewayAddress = await cargo.senderCertificate.calculateSubjectPrivateAddress();
  try {
    await parcel.validate([cargo.senderCertificate]);
  } catch (err) {
    logger.info(
      { cargoId: cargo.id, err, peerGatewayAddress, worker: workerName },
      'Parcel is invalid and/or did not originate in the gateway that created the cargo',
    );
    // TODO: The parcel should be ignored when the following bug is fixed:
    // https://github.com/relaycorp/relaynet-internet-gateway/issues/15
    // return;
  }

  if (await wasParcelCollected(parcel, peerGatewayAddress, mongooseConnection)) {
    logger.debug(
      {
        cargoId: cargo.id,
        parcelId: parcel.id,
        parcelSenderAddress: await parcel.senderCertificate.calculateSubjectPrivateAddress(),
        peerGatewayAddress,
        worker: workerName,
      },
      'Parcel was previously processed',
    );
    return;
  }
  await natsStreamingClient.publishMessage(Buffer.from(parcelSerialized), 'crc-parcels');
  await recordParcelCollection(parcel, peerGatewayAddress, mongooseConnection);
}

async function processPca(
  pca: ParcelCollectionAck,
  peerGatewayAddress: string,
  parcelStore: ParcelStore,
  cargoId: string,
  workerName: string,
): Promise<void> {
  try {
    await parcelStore.deleteGatewayBoundParcel(
      pca.parcelId,
      pca.senderEndpointPrivateAddress,
      pca.recipientEndpointAddress,
      peerGatewayAddress,
    );
  } catch (err) {
    logger.debug({ cargoId, err, peerGatewayAddress, workerName }, 'Could not find parcel for PCA');
  }
}
