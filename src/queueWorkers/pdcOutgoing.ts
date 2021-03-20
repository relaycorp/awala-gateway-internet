import {
  deliverParcel,
  PoHTTPClientBindingError,
  PoHTTPInvalidParcelError,
} from '@relaycorp/relaynet-pohttp';
import { get as getEnvVar } from 'env-var';
import pipe from 'it-pipe';
import * as stan from 'node-nats-streaming';

import { NatsStreamingClient } from '../backingServices/natsStreaming';
import { initObjectStoreFromEnv } from '../backingServices/objectStorage';
import { ParcelStore, QueuedInternetBoundParcelMessage } from '../parcelStore';
import { configureExitHandling } from '../utilities/exitHandling';
import { makeLogger } from '../utilities/logging';

const MAX_DELIVERY_ATTEMPTS = 3;

interface ActiveParcelData extends QueuedInternetBoundParcelMessage {
  // tslint:disable-next-line:no-mixed-interface
  readonly ack: () => void;
}

export async function processInternetBoundParcels(
  workerName: string,
  ownPohttpAddress: string,
): Promise<void> {
  const logger = makeLogger().child({ worker: workerName });
  configureExitHandling(logger);
  logger.info('Starting queue worker');

  const parcelStoreBucket = getEnvVar('OBJECT_STORE_BUCKET').required().asString();
  const parcelStore = new ParcelStore(initObjectStoreFromEnv(), parcelStoreBucket);

  const natsStreamingClient = NatsStreamingClient.initFromEnv(workerName);

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
          ...messageData,
          ack: () => message.ack(),
        };
      } else {
        await parcelStore.deleteEndpointBoundParcel(messageData.parcelObjectKey);
        message.ack();
      }
    }
  }

  async function deliverParcels(activeParcels: AsyncIterable<ActiveParcelData>): Promise<void> {
    for await (const parcelData of activeParcels) {
      const parcelAwareLogger = logger.child({ parcelObjectKey: parcelData.parcelObjectKey });
      const parcelSerialized = await parcelStore.retrieveEndpointBoundParcel(
        parcelData.parcelObjectKey,
      );

      if (!parcelSerialized) {
        parcelAwareLogger.warn('Parcel object could not be found');
        parcelData.ack();
        continue;
      }

      let wasParcelDelivered = true;
      try {
        await deliverParcel(parcelData.parcelRecipientAddress, parcelSerialized, {
          gatewayAddress: ownPohttpAddress,
        });
      } catch (err) {
        wasParcelDelivered = false;

        if (err instanceof PoHTTPInvalidParcelError) {
          parcelAwareLogger.info({ reason: err.message }, 'Parcel was rejected as invalid');
        } else if (err instanceof PoHTTPClientBindingError) {
          // The server claimed we're violating the binding
          parcelAwareLogger.info({ reason: err.message }, 'Discarding parcel due to binding issue');
        } else {
          // The server returned a 50X response or there was a networking issue

          const deliveryAttempts = (parcelData.deliveryAttempts ?? 0) + 1;
          if (deliveryAttempts < MAX_DELIVERY_ATTEMPTS) {
            const retryParcelData: QueuedInternetBoundParcelMessage = {
              ...{ ...parcelData, ack: undefined },
              deliveryAttempts,
            };
            await natsStreamingClient.publishMessage(
              JSON.stringify(retryParcelData),
              'internet-parcels',
            );

            parcelAwareLogger.info({ err }, 'Failed to deliver parcel; will try again later');
            parcelData.ack();
            continue;
          }

          parcelAwareLogger.info({ err }, 'Failed to deliver parcel again; will now give up');
        }
      }

      parcelData.ack();

      if (wasParcelDelivered) {
        parcelAwareLogger.debug('Parcel was successfully delivered');
      }

      await parcelStore.deleteEndpointBoundParcel(parcelData.parcelObjectKey);
    }
  }

  const queueConsumer = natsStreamingClient.makeQueueConsumer(
    'internet-parcels',
    'worker',
    'worker',
  );
  await pipe(queueConsumer, parseMessages, deliverParcels);
}
