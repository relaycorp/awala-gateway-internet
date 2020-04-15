import pino from 'pino';

import { ObjectStoreClient, StoreObject } from '../backingServices/objectStorage';

const LOGGER = pino();

export const GATEWAY_BOUND_OBJECT_KEY_PREFIX = 'parcels/gateway-bound';
export const EXPIRY_METADATA_KEY = 'parcel-expiry';

export class ParcelStore {
  constructor(protected objectStoreClient: ObjectStoreClient, protected bucket: string) {}

  public async *retrieveActiveParcelsForGateway(gatewayAddress: string): AsyncIterable<Buffer> {
    const prefix = `${GATEWAY_BOUND_OBJECT_KEY_PREFIX}/${gatewayAddress}/`;
    const objectKeys = this.objectStoreClient.listObjectKeys(prefix, this.bucket);
    for await (const parcelObjectKey of objectKeys) {
      // tslint:disable-next-line:no-let
      let parcelObject: StoreObject;
      try {
        parcelObject = await this.objectStoreClient.getObject(parcelObjectKey, this.bucket);
      } catch (error) {
        LOGGER.warn(
          { parcelObjectKey },
          'Parcel object could not be found; it could have been deleted since keys were retrieved',
        );
        continue;
      }
      if (!isParcelStillValid(parcelObject.metadata[EXPIRY_METADATA_KEY], parcelObjectKey)) {
        continue;
      }
      yield parcelObject.body;
    }
  }
}

function isParcelStillValid(parcelExpiryTimestampString: string, parcelObjectKey: string): boolean {
  if (!parcelExpiryTimestampString) {
    LOGGER.error({ parcelObjectKey }, 'Parcel object does not have expiry timestamp metadata');
    return false;
  }
  const parcelExpiryTimestamp = parseInt(parcelExpiryTimestampString, 10);
  const parcelExpiryDate = new Date(parcelExpiryTimestamp * 1_000);
  if (Number.isNaN(parcelExpiryDate.getTime())) {
    LOGGER.error(
      { parcelObjectKey },
      'Parcel object does not have a valid expiry timestamp metadata',
    );
    return false;
  }

  return new Date() < parcelExpiryDate;
}

// TODO: Move here
// async function storeParcel(_parcel: Parcel, _parcelSerialized: Buffer): Promise<string> {
//   throw new Error('Not implemented');
// }
