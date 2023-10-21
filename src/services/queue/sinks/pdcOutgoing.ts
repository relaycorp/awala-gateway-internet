import {
  deliverParcel,
  PoHTTPClientBindingError,
  PoHTTPError,
  PoHTTPInvalidParcelError,
} from '@relaycorp/relaynet-pohttp';
import { get as getEnvVar } from 'env-var';
import { parseISO } from 'date-fns';
import { FastifyBaseLogger } from 'fastify';

import { MessageSink } from '../types';
import { EVENT_TYPES } from './types';

async function attemptParcelDelivery(
  parcelSerialised: Buffer,
  recipientInternetAddress: string,
  logger: FastifyBaseLogger,
): Promise<boolean> {
  const useTls = getEnvVar('POHTTP_USE_TLS').default('true').asBool();
  const recipientAwareLogger = logger.child({ recipientInternetAddress });
  try {
    await deliverParcel(recipientInternetAddress, parcelSerialised, { useTls });
    recipientAwareLogger.debug('Parcel was successfully delivered');
  } catch (err) {
    if (err instanceof PoHTTPInvalidParcelError) {
      recipientAwareLogger.info({ reason: err.message }, 'Parcel was rejected as invalid');
    } else if (err instanceof PoHTTPClientBindingError) {
      // The server claimed we're violating the binding
      recipientAwareLogger.info({ reason: err.message }, 'Discarding parcel due to binding issue');
    } else if (err instanceof PoHTTPError) {
      // The server returned a 50X response or there was a networking issue
      recipientAwareLogger.info({ err }, 'Failed to deliver parcel; will try again later');
      return false;
    } else {
      recipientAwareLogger.error({ err }, 'Failed to deliver parcel due to unexpected error');
      return false;
    }
  }

  return true;
}

const pdcOutgoing: MessageSink = {
  eventType: EVENT_TYPES.PDC_OUTGOING_PARCEL,
  handler: async (event, { logger }) => {
    const parcelId = event.subject;
    const privatePeerId = event.source;
    const parcelAwareLogger = logger.child({ parcelId, privatePeerId });

    if (!parcelId) {
      parcelAwareLogger.warn('Refused outgoing parcel with missing subject');
      return true;
    }

    const expiryRaw = event.expiry as string | undefined;
    if (!expiryRaw) {
      parcelAwareLogger.warn('Refused outgoing parcel with missing expiry');
      return true;
    }
    const expiry = parseISO(expiryRaw);
    if (expiry < new Date()) {
      parcelAwareLogger.info({ expiry }, 'Ignoring expired parcel');
      return true;
    }

    const recipientInternetAddress = event.internetaddress as string | undefined;
    if (!recipientInternetAddress) {
      parcelAwareLogger.warn('Refused outgoing parcel with missing recipient Internet address');
      return true;
    }

    return attemptParcelDelivery(event.data!, recipientInternetAddress, parcelAwareLogger);
  },
};

export default pdcOutgoing;
