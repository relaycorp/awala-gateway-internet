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
import { InternetGateway } from '../node/InternetGateway';
import { InternetGatewayManager } from '../node/InternetGatewayManager';
import { ParcelStore } from '../parcelStore';
import { configureExitHandling } from '../utilities/exitHandling';
import { makeLogger } from '../utilities/logging';
import { RedisPublishFunction, RedisPubSubClient } from '../backingServices/RedisPubSubClient';
import { Emitter } from '../utilities/eventing/Emitter';
import { EmitterChannel } from '../utilities/eventing/EmitterChannel';

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
  await pipeline(() => queueConsumer, makeCargoProcessor(logger));
}

function makeCargoProcessor(logger: Logger): (messages: AsyncIterable<Message>) => Promise<void> {
  return async (messages) => {
    const mongooseConnection = createMongooseConnectionFromEnv();
    const gatewayManager = await InternetGatewayManager.init(mongooseConnection);
    const gateway = await gatewayManager.getCurrent();

    const parcelStore = ParcelStore.initFromEnv();

    const emitter = await Emitter.init(EmitterChannel.PDC_OUTGOING);

    const redisClient = RedisPubSubClient.init();
    const redisPublisher = await redisClient.makePublisher();

    try {
      for await (const message of messages) {
        await processCargo(
          message,
          gateway,
          logger,
          parcelStore,
          mongooseConnection,
          emitter,
          redisPublisher.publish,
        );
      }
    } finally {
      await mongooseConnection.close();
      await redisPublisher.close();
    }
  };
}

async function processCargo(
  message: Message,
  gateway: InternetGateway,
  logger: Logger,
  parcelStore: ParcelStore,
  mongooseConnection: Connection,
  emitter: Emitter<Buffer>,
  redisPublish: RedisPublishFunction,
): Promise<void> {
  const cargo = await Cargo.deserialize(bufferToArray(message.getRawData()));
  const privatePeerId = await cargo.senderCertificate.calculateSubjectId();

  const cargoAwareLogger = logger.child({ cargoId: cargo.id, privatePeerId });

  let cargoMessageSet: CargoMessageSet;
  try {
    cargoMessageSet = await gateway.unwrapMessagePayload(cargo);
  } catch (err) {
    if (err instanceof KeyStoreError) {
      cargoAwareLogger.fatal({ err }, 'Failed to use key store to unwrap message');
    } else {
      cargoAwareLogger.info({ err }, 'Cargo payload is invalid');
      message.ack();
    }
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
        privatePeerId,
        parcelStore,
        mongooseConnection,
        emitter,
        redisPublish,
        cargoAwareLogger.child({ parcelId: item.id }),
      );
    } else if (item instanceof ParcelCollectionAck) {
      await parcelStore.deleteParcelForPrivatePeer(
        item.parcelId,
        item.senderEndpointId,
        item.recipientEndpointId,
        privatePeerId,
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
  privatePeerId: string,
  parcelStore: ParcelStore,
  mongooseConnection: Connection,
  emitter: Emitter<Buffer>,
  redisPublish: RedisPublishFunction,
  parcelAwareLogger: Logger,
): Promise<void> {
  let wasParcelStored: boolean;
  try {
    wasParcelStored = await parcelStore.storeParcelFromPrivatePeer(
      parcel,
      parcelSerialized,
      privatePeerId,
      mongooseConnection,
      emitter,
      redisPublish,
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
    { parcelSenderAddress: await parcel.senderCertificate.calculateSubjectId() },
    wasParcelStored ? 'Parcel was stored' : 'Ignoring previously processed parcel',
  );
}
