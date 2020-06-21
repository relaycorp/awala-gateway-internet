import { CargoMessageStream, Parcel } from '@relaycorp/relaynet-core';
import { createHash } from 'crypto';
import pino from 'pino';
import uuid from 'uuid-random';

import { ObjectStoreClient, StoreObject } from '../backingServices/objectStorage';
import { convertDateToTimestamp } from '../utils';

const LOGGER = pino();

const GATEWAY_BOUND_OBJECT_KEY_PREFIX = 'parcels/gateway-bound';
const ENDPOINT_BOUND_OBJECT_KEY_PREFIX = 'parcels/endpoint-bound';
const EXPIRY_METADATA_KEY = 'parcel-expiry';

export class ParcelStore {
  constructor(protected objectStoreClient: ObjectStoreClient, public readonly bucket: string) {}

  public async *retrieveActiveParcelsForGateway(gatewayAddress: string): CargoMessageStream {
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

      const parcelExpiryDate = getDateFromTimestamp(parcelObject.metadata[EXPIRY_METADATA_KEY]);
      if (parcelExpiryDate === null) {
        LOGGER.error(
          { parcelObjectKey },
          'Parcel object does not have a valid expiry timestamp metadata',
        );
        continue;
      } else if (parcelExpiryDate <= new Date()) {
        continue;
      }
      yield { expiryDate: parcelExpiryDate, message: parcelObject.body };
    }
  }

  public async storeGatewayBoundParcel(
    parcel: Parcel,
    parcelSerialized: Buffer,
    privateGatewayAddress: string,
  ): Promise<string> {
    const key = calculatedGatewayBoundParcelObjectKey(
      parcel.id,
      await parcel.senderCertificate.calculateSubjectPrivateAddress(),
      parcel.recipientAddress,
      privateGatewayAddress,
    );
    await this.objectStoreClient.putObject(
      {
        body: parcelSerialized,
        metadata: { [EXPIRY_METADATA_KEY]: convertDateToTimestamp(parcel.expiryDate).toString() },
      },
      key,
      this.bucket,
    );
    return key;
  }

  /**
   * Delete specified parcel if it exists.
   *
   * @param parcelId
   * @param senderPrivateAddress
   * @param recipientAddress
   * @param recipientGatewayAddress
   */
  public async deleteGatewayBoundParcel(
    parcelId: string,
    senderPrivateAddress: string,
    recipientAddress: string,
    recipientGatewayAddress: string,
  ): Promise<void> {
    const parcelKey = calculatedGatewayBoundParcelObjectKey(
      parcelId,
      senderPrivateAddress,
      recipientAddress,
      recipientGatewayAddress,
    );
    await this.objectStoreClient.deleteObject(parcelKey, this.bucket);
  }

  public async retrieveEndpointBoundParcel(parcelObjectKey: string): Promise<Buffer> {
    const storeObject = await this.objectStoreClient.getObject(
      makeFullInternetBoundObjectKey(parcelObjectKey),
      this.bucket,
    );
    return storeObject.body;
  }

  public async storeEndpointBoundParcel(parcelSerialized: Buffer): Promise<string> {
    const objectKey = uuid();
    await this.objectStoreClient.putObject(
      { body: parcelSerialized, metadata: {} },
      makeFullInternetBoundObjectKey(objectKey),
      this.bucket,
    );
    return objectKey;
  }

  public async deleteEndpointBoundParcel(parcelObjectKey: string): Promise<void> {
    await this.objectStoreClient.deleteObject(
      makeFullInternetBoundObjectKey(parcelObjectKey),
      this.bucket,
    );
  }
}

function getDateFromTimestamp(timestampString: string): Date | null {
  if (!timestampString) {
    return null;
  }

  const parcelExpiryTimestamp = parseInt(timestampString, 10);
  const parcelExpiryDate = new Date(parcelExpiryTimestamp * 1_000);
  return Number.isNaN(parcelExpiryDate.getTime()) ? null : parcelExpiryDate;
}

function makeFullInternetBoundObjectKey(parcelObjectKey: string): string {
  return `${ENDPOINT_BOUND_OBJECT_KEY_PREFIX}/${parcelObjectKey}`;
}

function calculatedGatewayBoundParcelObjectKey(
  parcelId: string,
  senderPrivateAddress: string,
  recipientAddress: string,
  recipientGatewayAddress: string,
): string {
  return [
    GATEWAY_BOUND_OBJECT_KEY_PREFIX,
    recipientGatewayAddress,
    recipientAddress,
    senderPrivateAddress,
    sha256Hex(parcelId), // Use the digest to avoid using potentially illegal characters
  ].join('/');
}

function sha256Hex(plaintext: string): string {
  return createHash('sha256')
    .update(plaintext)
    .digest('hex');
}
