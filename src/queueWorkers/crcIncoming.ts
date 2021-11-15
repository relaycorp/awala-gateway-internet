import {
  Cargo,
  CargoMessageSet,
  GatewayManager,
  InvalidMessageError,
  Parcel,
  ParcelCollectionAck,
  PrivateKeyStoreError,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { get as getEnvVar } from 'env-var';
import pipe from 'it-pipe';
import { Connection } from 'mongoose';
import { Message } from 'node-nats-streaming';
import { Logger } from 'pino';

import { createMongooseConnectionFromEnv } from '../backingServices/mongo';
import { NatsStreamingClient } from '../backingServices/natsStreaming';
import { initObjectStoreFromEnv } from '../backingServices/objectStorage';
import { initVaultKeyStore } from '../backingServices/vault';
import { MongoPublicKeyStore } from '../MongoPublicKeyStore';
import { ParcelStore } from '../parcelStore';
import { configureExitHandling } from '../utilities/exitHandling';
import { makeLogger } from '../utilities/logging';

export async function processIncomingCrcCargo(workerName: string): Promise<void> {
  const logger = makeLogger().child({ worker: workerName });
  configureExitHandling(logger);
  logger.info('Starting queue worker');

  const natsStreamingClient = NatsStreamingClient.initFromEnv(workerName);

  const queueConsumer = natsStreamingClient.makeQueueConsumer(
    'crc-cargo',
    'worker',
    'worker',
    undefined,
    '-consumer',
  );
  await pipe(queueConsumer, makeCargoProcessor(natsStreamingClient, logger));
}

function makeCargoProcessor(
  natsStreamingClient: NatsStreamingClient,
  logger: Logger,
): (messages: AsyncIterable<Message>) => Promise<void> {
  return async (messages) => {
    const mongooseConnection = await createMongooseConnectionFromEnv();
    const gateway = new GatewayManager(
      initVaultKeyStore(),
      new MongoPublicKeyStore(mongooseConnection),
    );

    const objectStoreClient = initObjectStoreFromEnv();
    const parcelStoreBucket = getEnvVar('OBJECT_STORE_BUCKET').required().asString();
    const parcelStore = new ParcelStore(objectStoreClient, parcelStoreBucket);

    try {
      for await (const message of messages) {
        await processCargo(
          message,
          gateway,
          logger,
          parcelStore,
          mongooseConnection,
          natsStreamingClient,
        );
      }
    } finally {
      await mongooseConnection.close();
    }
  };
}

async function processCargo(
  message: Message,
  gatewayManager: GatewayManager,
  logger: Logger,
  parcelStore: ParcelStore,
  mongooseConnection: Connection,
  natsStreamingClient: NatsStreamingClient,
): Promise<void> {
  const cargo = await Cargo.deserialize(bufferToArray(message.getRawData()));
  const peerGatewayAddress = await cargo.senderCertificate.calculateSubjectPrivateAddress();

  const cargoAwareLogger = logger.child({ cargoId: cargo.id, peerGatewayAddress });

  let cargoMessageSet: CargoMessageSet;
  try {
    cargoMessageSet = await gatewayManager.unwrapMessagePayload(cargo);
  } catch (err) {
    if (err instanceof PrivateKeyStoreError) {
      // Vault is down or returned an unexpected response
      throw err;
    }
    cargoAwareLogger.info({ err }, 'Cargo payload is invalid');
    message.ack();
    return;
  }

  for (const itemSerialized of cargoMessageSet.messages) {
    let item: Parcel | ParcelCollectionAck;
    try {
      item = await CargoMessageSet.deserializeItem(itemSerialized);
    } catch (err) {
      cargoAwareLogger.info({ err }, 'Cargo contains an invalid message');
      continue;
    }
    if (item instanceof Parcel) {
      await processParcel(
        item,
        Buffer.from(itemSerialized),
        peerGatewayAddress,
        parcelStore,
        mongooseConnection,
        natsStreamingClient,
        cargoAwareLogger.child({ parcelId: item.id }),
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

async function processParcel(
  parcel: Parcel,
  parcelSerialized: Buffer,
  peerGatewayAddress: string,
  parcelStore: ParcelStore,
  mongooseConnection: Connection,
  natsStreamingClient: NatsStreamingClient,
  parcelAwareLogger: Logger,
): Promise<void> {
  let parcelObjectKey: string | null;
  try {
    parcelObjectKey = await parcelStore.storeParcelFromPeerGateway(
      parcel,
      parcelSerialized,
      peerGatewayAddress,
      mongooseConnection,
      natsStreamingClient,
      parcelAwareLogger,
    );
  } catch (err) {
    if (err instanceof InvalidMessageError) {
      parcelAwareLogger.info({ err }, 'Parcel is invalid');
      return;
    }

    throw err;
  }

  parcelAwareLogger.debug(
    {
      parcelObjectKey,
      parcelSenderAddress: await parcel.senderCertificate.calculateSubjectPrivateAddress(),
    },
    parcelObjectKey ? 'Parcel was stored' : 'Ignoring previously processed parcel',
  );
}
