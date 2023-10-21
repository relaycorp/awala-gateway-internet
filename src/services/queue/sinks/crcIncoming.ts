import {
  Cargo,
  CargoMessageSet,
  CertificateRotation,
  InvalidMessageError,
  KeyStoreError,
  Parcel,
  ParcelCollectionAck,
} from '@relaycorp/relaynet-core';
import type { FastifyBaseLogger } from 'fastify';
import { Connection } from 'mongoose';

import type { ParcelStore } from '../../../parcelStore';
import type { RedisPublishFunction } from '../../../backingServices/RedisPubSubClient';
import type { QueueEmitter } from '../../../utilities/backgroundQueue/QueueEmitter';
import type { MessageSink } from '../types';
import { EVENT_TYPES } from './types';

const crcIncoming: MessageSink = {
  eventType: EVENT_TYPES.CRC_INCOMING_CARGO,
  handler: async (
    event,
    { dbConnection, logger, gatewayManager, queueEmitter, parcelStore, redisPublish },
  ) => {
    const privatePeerId = event.source;
    const cargoAwareLogger = logger.child({ cargoId: event.subject, privatePeerId });

    let cargo: Cargo;
    try {
      cargo = await Cargo.deserialize(event.data!);
    } catch (err) {
      cargoAwareLogger.info({ err }, 'Refusing malformed cargo');
      return true;
    }

    const gateway = await gatewayManager.getCurrent();
    let cargoMessageSet: CargoMessageSet;
    try {
      cargoMessageSet = await gateway.unwrapMessagePayload(cargo);
    } catch (err) {
      if (err instanceof KeyStoreError) {
        cargoAwareLogger.error({ err }, 'Failed to use key store to unwrap message');
        return false;
      }

      cargoAwareLogger.info({ err }, 'Cargo payload is invalid');
      return true;
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
          dbConnection,
          queueEmitter,
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
        cargoAwareLogger.info({ parcelId: item.parcelId }, 'Deleted parcel associated with PCA');
      } else {
        cargoAwareLogger.info('Ignoring certificate rotation message');
      }
    }

    return true;
  },
};

export default crcIncoming;

async function processParcel(
  parcel: Parcel,
  parcelSerialized: Buffer,
  privatePeerId: string,
  parcelStore: ParcelStore,
  mongooseConnection: Connection,
  emitter: QueueEmitter,
  redisPublish: RedisPublishFunction,
  parcelAwareLogger: FastifyBaseLogger,
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
