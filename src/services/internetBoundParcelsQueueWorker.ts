import { deliverParcel, PoHTTPInvalidParcelError } from '@relaycorp/relaynet-pohttp';
import { get as getEnvVar } from 'env-var';
import pipe from 'it-pipe';
import * as stan from 'node-nats-streaming';
import pino from 'pino';

import { NatsStreamingClient } from '../backingServices/natsStreaming';
import { ObjectStoreClient } from '../backingServices/objectStorage';
import { ParcelStore } from './parcelStore';

interface ActiveParcelData {
  readonly parcelObjectKey: string;
  readonly parcelRecipientAddress: string;
  // tslint:disable-next-line:no-mixed-interface
  readonly ack: () => void;
}

export interface QueuedInternetBoundParcelMessage {
  readonly parcelObjectKey: string;
  readonly parcelRecipientAddress: string;
  readonly parcelExpiryDate: Date;
}

const LOGGER = pino();

export async function processInternetBoundParcels(
  workerName: string,
  ownPohttpAddress: string,
): Promise<void> {
  const parcelStoreBucket = getEnvVar('OBJECT_STORE_BUCKET').required().asString();
  const parcelStore = new ParcelStore(ObjectStoreClient.initFromEnv(), parcelStoreBucket);

  async function* parseMessages(
    messages: AsyncIterable<stan.Message>,
  ): AsyncIterable<ActiveParcelData> {
    for await (const message of messages) {
      const messageData: QueuedInternetBoundParcelMessage = JSON.parse(
        message.getRawData().toString(),
      );

      const now = new Date();
      const parcelExpiryDate = new Date(messageData.parcelExpiryDate);
      if (now < parcelExpiryDate) {
        yield {
          ack: () => message.ack(),
          parcelObjectKey: messageData.parcelObjectKey,
          parcelRecipientAddress: messageData.parcelRecipientAddress,
        };
      } else {
        await parcelStore.deleteEndpointBoundParcel(messageData.parcelObjectKey);
        message.ack();
      }
    }
  }

  async function deliverParcels(activeParcels: AsyncIterable<ActiveParcelData>): Promise<void> {
    for await (const parcelData of activeParcels) {
      const parcelSerialized = await parcelStore.retrieveEndpointBoundParcel(
        parcelData.parcelObjectKey,
      );

      // tslint:disable-next-line:no-let
      let wasParcelDelivered = true;
      try {
        await deliverParcel(parcelData.parcelRecipientAddress, parcelSerialized, {
          gatewayAddress: ownPohttpAddress,
        });
      } catch (err) {
        wasParcelDelivered = false;
        if (err instanceof PoHTTPInvalidParcelError) {
          LOGGER.info(
            { err, parcelObjectKey: parcelData.parcelObjectKey },
            'Parcel was rejected as invalid',
          );
        } else {
          LOGGER.warn(
            { err, parcelObjectKey: parcelData.parcelObjectKey },
            'Failed to deliver parcel',
          );
          continue;
        }
      }

      if (wasParcelDelivered) {
        LOGGER.debug(
          { parcelObjectKey: parcelData.parcelObjectKey },
          'Parcel was successfully delivered',
        );
      }

      await parcelStore.deleteEndpointBoundParcel(parcelData.parcelObjectKey);
      parcelData.ack();
    }
  }

  const natsStreamingClient = NatsStreamingClient.initFromEnv(workerName);
  const queueConsumer = natsStreamingClient.makeQueueConsumer('crc-parcels', 'worker', 'worker');
  try {
    await pipe(queueConsumer, parseMessages, deliverParcels);
  } finally {
    natsStreamingClient.disconnect();
  }
}
