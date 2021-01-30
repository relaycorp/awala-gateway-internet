import { deliverParcel, PoHTTPInvalidParcelError } from '@relaycorp/relaynet-pohttp';
import { get as getEnvVar } from 'env-var';
import pipe from 'it-pipe';
import * as stan from 'node-nats-streaming';

import { NatsStreamingClient } from '../backingServices/natsStreaming';
import { initObjectStoreFromEnv } from '../backingServices/objectStorage';
import { makeLogger } from '../utilities/logging';
import { ParcelStore, QueuedInternetBoundParcelMessage } from './parcelStore';

interface ActiveParcelData {
  readonly parcelObjectKey: string;
  readonly parcelRecipientAddress: string;
  // tslint:disable-next-line:no-mixed-interface
  readonly ack: () => void;
}

export async function processInternetBoundParcels(
  workerName: string,
  ownPohttpAddress: string,
): Promise<void> {
  const logger = makeLogger();

  const parcelStoreBucket = getEnvVar('OBJECT_STORE_BUCKET').required().asString();
  const parcelStore = new ParcelStore(initObjectStoreFromEnv(), parcelStoreBucket);

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

      let wasParcelDelivered = true;
      try {
        await deliverParcel(parcelData.parcelRecipientAddress, parcelSerialized, {
          gatewayAddress: ownPohttpAddress,
        });
      } catch (err) {
        wasParcelDelivered = false;
        if (err instanceof PoHTTPInvalidParcelError) {
          logger.info(
            { err, parcelObjectKey: parcelData.parcelObjectKey },
            'Parcel was rejected as invalid',
          );
        } else {
          logger.warn(
            { err, parcelObjectKey: parcelData.parcelObjectKey },
            'Failed to deliver parcel',
          );
          continue;
        }
      }

      if (wasParcelDelivered) {
        logger.debug(
          { parcelObjectKey: parcelData.parcelObjectKey },
          'Parcel was successfully delivered',
        );
      }

      await parcelStore.deleteEndpointBoundParcel(parcelData.parcelObjectKey);
      parcelData.ack();
    }
  }

  const natsStreamingClient = NatsStreamingClient.initFromEnv(workerName);
  const queueConsumer = natsStreamingClient.makeQueueConsumer(
    'internet-parcels',
    'worker',
    'worker',
  );
  await pipe(queueConsumer, parseMessages, deliverParcels);
}
