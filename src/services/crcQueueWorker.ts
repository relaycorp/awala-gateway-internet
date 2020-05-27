import {
  Cargo,
  CargoMessageSet,
  OriginatorSessionKey,
  Parcel,
  PrivateKeyStoreError,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import pipe from 'it-pipe';
import * as stan from 'node-nats-streaming';
import pino from 'pino';

import { createMongooseConnectionFromEnv } from '../backingServices/mongo';
import { NatsStreamingClient, PublisherMessage } from '../backingServices/natsStreaming';
import { initVaultKeyStore } from '../backingServices/privateKeyStore';
import { MongoPublicKeyStore } from './MongoPublicKeyStore';
import { recordParcelCollection, wasParcelCollected } from './parcelCollection';

const logger = pino();

export async function processIncomingCrcCargo(workerName: string): Promise<void> {
  const natsStreamingClient = NatsStreamingClient.initFromEnv(workerName);
  const privateKeyStore = initVaultKeyStore();

  const mongooseConnection = await createMongooseConnectionFromEnv();
  const publicKeyStore = new MongoPublicKeyStore(mongooseConnection);

  async function* unwrapCargoPayload(
    messages: AsyncIterable<stan.Message>,
  ): AsyncIterable<PublisherMessage> {
    for await (const message of messages) {
      const cargo = await Cargo.deserialize(bufferToArray(message.getRawData()));
      // tslint:disable-next-line:no-let
      let unwrapResult: {
        readonly payload: CargoMessageSet;
        readonly senderSessionKey?: OriginatorSessionKey;
      };
      const senderAddress = await cargo.senderCertificate.calculateSubjectPrivateAddress();
      try {
        unwrapResult = await cargo.unwrapPayload(privateKeyStore);
      } catch (err) {
        if (err instanceof PrivateKeyStoreError) {
          logger.error(
            { cargoId: cargo.id, err, senderAddress, worker: workerName },
            'Failed to retrieve key from Vault',
          );
        } else {
          logger.info(
            { cargoId: cargo.id, err, senderAddress, worker: workerName },
            'Cargo payload is invalid',
          );
          message.ack();
        }
        break;
      }

      // If the sender uses channel session, store its public key for later use.
      if (unwrapResult.senderSessionKey) {
        await publicKeyStore.saveSessionKey(
          unwrapResult.senderSessionKey,
          cargo.senderCertificate,
          cargo.creationDate,
        );
      }

      for (const parcelSerialized of unwrapResult.payload.messages) {
        // tslint:disable-next-line:no-let
        let parcel: Parcel;
        try {
          parcel = await Parcel.deserialize(parcelSerialized);
        } catch (error) {
          logger.info(
            { cargoId: cargo.id, error, senderAddress },
            'Cargo contains an invalid message',
          );
          continue;
        }

        try {
          await parcel.validate([cargo.senderCertificate]);
        } catch (err) {
          logger.info(
            { cargoId: cargo.id, err, senderAddress, worker: workerName },
            'Parcel is invalid and/or did not originate in the gateway that created the cargo',
          );
          // TODO: The parcel should be ignored when the following bug is fixed:
          // https://github.com/relaycorp/relaynet-internet-gateway/issues/15
          // continue;
        }

        if (await wasParcelCollected(parcel, senderAddress, mongooseConnection)) {
          logger.debug(
            {
              cargoId: cargo.id,
              parcelId: parcel.id,
              parcelSenderAddress: await parcel.senderCertificate.calculateSubjectPrivateAddress(),
              senderAddress,
              worker: workerName,
            },
            'Parcel was previously processed',
          );
          continue;
        }
        yield { data: Buffer.from(parcelSerialized), id: 'ignored-id' };
        await recordParcelCollection(parcel, senderAddress, mongooseConnection);
      }
      message.ack();
    }
  }

  const parcelPublisher = natsStreamingClient.makePublisher('crc-parcels');

  const queueConsumer = natsStreamingClient.makeQueueConsumer('crc-cargo', 'worker', 'worker');
  try {
    await pipe(queueConsumer, unwrapCargoPayload, parcelPublisher, consumeAsyncIterator);
  } finally {
    natsStreamingClient.disconnect();
  }
}

async function consumeAsyncIterator<T>(iterator: AsyncIterable<T>): Promise<void> {
  // I'm sure there's a cleaner/simpler way to create a sink iterator but I'm out of ideas.
  // tslint:disable-next-line:no-empty
  for await (const _ of iterator) {
  }
}
