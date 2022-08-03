import {
  deliverParcel,
  PoHTTPClientBindingError,
  PoHTTPError,
  PoHTTPInvalidParcelError,
} from '@relaycorp/relaynet-pohttp';
import * as stan from 'node-nats-streaming';
import { pipeline } from 'streaming-iterables';

import { NatsStreamingClient } from '../backingServices/natsStreaming';
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

  const parcelStore = ParcelStore.initFromEnv();

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
        await parcelStore.deleteParcelForInternetPeer(messageData.parcelObjectKey);
        message.ack();
      }
    }
  }

  async function deliverParcels(activeParcels: AsyncIterable<ActiveParcelData>): Promise<void> {
    for await (const parcelData of activeParcels) {
      const parcelAwareLogger = logger.child({ parcelObjectKey: parcelData.parcelObjectKey });
      const parcelSerialized = await parcelStore.retrieveParcelForInternetPeer(
        parcelData.parcelObjectKey,
      );

      if (!parcelSerialized) {
        parcelAwareLogger.warn('Parcel object could not be found');
        parcelData.ack();
        continue;
      }

      const deliveryAttempts = (parcelData.deliveryAttempts ?? 0) + 1;
      try {
        await deliverParcel(parcelData.parcelRecipientAddress, parcelSerialized, {
          gatewayAddress: ownPohttpAddress,
        });
        parcelAwareLogger.debug('Parcel was successfully delivered');
      } catch (err) {
        if (!(err instanceof PoHTTPError)) {
          // There's a bug in the `try` block above or the PoHTTP library
          throw err;
        }
        if (err instanceof PoHTTPInvalidParcelError) {
          parcelAwareLogger.info({ reason: err.message }, 'Parcel was rejected as invalid');
        } else if (err instanceof PoHTTPClientBindingError) {
          // The server claimed we're violating the binding
          parcelAwareLogger.info({ reason: err.message }, 'Discarding parcel due to binding issue');
        } else if (MAX_DELIVERY_ATTEMPTS <= deliveryAttempts) {
          // The server returned a 50X response or there was a networking issue
          parcelAwareLogger.info({ err }, 'Failed to deliver parcel again; will now give up');
        } else {
          // The server returned a 50X response or there was a networking issue
          parcelAwareLogger.info({ err }, 'Failed to deliver parcel; will try again later');
          await addParcelBackToQueue(parcelData, deliveryAttempts, natsStreamingClient);
          parcelData.ack();
          continue;
        }
      }

      await parcelStore.deleteParcelForInternetPeer(parcelData.parcelObjectKey);
      parcelData.ack();
    }
  }

  const queueConsumer = natsStreamingClient.makeQueueConsumer(
    'internet-parcels',
    'worker',
    'worker',
  );
  await pipeline(() => queueConsumer, parseMessages, deliverParcels);
}

async function addParcelBackToQueue(
  parcelData: ActiveParcelData,
  deliveryAttempts: number,
  natsStreamingClient: NatsStreamingClient,
): Promise<void> {
  const retryParcelData: QueuedInternetBoundParcelMessage = {
    ...{ ...parcelData, ack: undefined },
    deliveryAttempts,
  };
  await natsStreamingClient.publishMessage(
    JSON.stringify(retryParcelData),
    'internet-parcels',
    'retry',
  );
}
