import {
  Cargo,
  CargoMessageSet,
  CertificateRotation,
  InvalidMessageError,
  KeyStoreError,
  Parcel,
  ParcelCollectionAck,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { Connection } from 'mongoose';
import { Message } from 'node-nats-streaming';
import { Logger } from 'pino';
import { pipeline } from 'streaming-iterables';

import { createMongooseConnectionFromEnv } from '../backingServices/mongo';
import { NatsStreamingClient } from '../backingServices/natsStreaming';
import { PublicGatewayError } from '../errors';
import { PublicGateway } from '../node/PublicGateway';
import { PublicGatewayManager } from '../node/PublicGatewayManager';
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
  await pipeline(() => queueConsumer, makeCargoProcessor(natsStreamingClient, logger));
}

function makeCargoProcessor(
  natsStreamingClient: NatsStreamingClient,
  logger: Logger,
): (messages: AsyncIterable<Message>) => Promise<void> {
  return async (messages) => {
    const mongooseConnection = await createMongooseConnectionFromEnv();
    const gatewayManager = await PublicGatewayManager.init(mongooseConnection);
    const gateway = await gatewayManager.getCurrent();

    const parcelStore = ParcelStore.initFromEnv();

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
  gateway: PublicGateway,
  logger: Logger,
  parcelStore: ParcelStore,
  mongooseConnection: Connection,
  natsStreamingClient: NatsStreamingClient,
): Promise<void> {
  const cargo = await Cargo.deserialize(bufferToArray(message.getRawData()));
  const peerGatewayAddress = await cargo.senderCertificate.calculateSubjectId();

  const cargoAwareLogger = logger.child({ cargoId: cargo.id, peerGatewayAddress });

  let cargoMessageSet: CargoMessageSet;
  try {
    cargoMessageSet = await gateway.unwrapMessagePayload(cargo);
  } catch (err) {
    if (err instanceof KeyStoreError) {
      throw new PublicGatewayError(err, 'Failed to use key store to unwrap message');
    }
    cargoAwareLogger.info({ err }, 'Cargo payload is invalid');
    message.ack();
    return;
  }

  for (const itemSerialized of cargoMessageSet.messages) {
    let item: Parcel | ParcelCollectionAck | CertificateRotation;
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
    } else if (item instanceof ParcelCollectionAck) {
      await parcelStore.deleteParcelForPrivatePeer(
        item.parcelId,
        item.senderEndpointId,
        item.recipientEndpointId,
        peerGatewayAddress,
      );
    } else {
      cargoAwareLogger.info('Ignoring certificate rotation message');
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
    parcelObjectKey = await parcelStore.storeParcelFromPrivatePeer(
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
      parcelSenderAddress: await parcel.senderCertificate.calculateSubjectId(),
    },
    parcelObjectKey ? 'Parcel was stored' : 'Ignoring previously processed parcel',
  );
}
