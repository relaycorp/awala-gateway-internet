import { CargoMessageStream, Parcel } from '@relaycorp/relaynet-core';
import { get as getEnvVar } from 'env-var';
import { Connection } from 'mongoose';
import pino from 'pino';
import uuid from 'uuid-random';

import { NatsStreamingClient } from '../backingServices/natsStreaming';
import { ObjectStoreClient, StoreObject } from '../backingServices/objectStorage';
import { convertDateToTimestamp, sha256Hex } from '../utils';
import { retrieveOwnCertificates } from './certs';
import { recordParcelCollection, wasParcelCollected } from './parcelCollection';

const LOGGER = pino();

const GATEWAY_BOUND_OBJECT_KEY_PREFIX = 'parcels/gateway-bound';
const ENDPOINT_BOUND_OBJECT_KEY_PREFIX = 'parcels/endpoint-bound';
const EXPIRY_METADATA_KEY = 'parcel-expiry';

export interface QueuedInternetBoundParcelMessage {
  readonly parcelObjectKey: string;
  readonly parcelRecipientAddress: string;
  readonly parcelExpiryDate: Date;
}

export class ParcelStore {
  public static initFromEnv(): ParcelStore {
    const objectStoreClient = ObjectStoreClient.initFromEnv();
    const objectStoreBucket = getEnvVar('OBJECT_STORE_BUCKET').required().asString();
    return new ParcelStore(objectStoreClient, objectStoreBucket);
  }

  constructor(public objectStoreClient: ObjectStoreClient, public readonly bucket: string) {}

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

  // public async storeParcel(
  //   _parcel: Parcel,
  //   _parcelSerialized: Buffer,
  //   _mongooseConnection: Connection,
  //   _natsStreamingConnection: NatsStreamingClient,
  // ): Promise<void> {
  //   throw new Error('implement!');
  // }

  /**
   * Store the `parcel`.
   *
   * @param parcel
   * @param parcelSerialized
   * @param mongooseConnection
   * @param natsStreamingClient
   * @throws InvalidMessageError if the parcel is invalid or its sender is not trusted/authorized
   */
  public async storeGatewayBoundParcel(
    parcel: Parcel,
    parcelSerialized: Buffer,
    mongooseConnection: Connection,
    natsStreamingClient: NatsStreamingClient,
  ): Promise<void> {
    const trustedCertificates = await retrieveOwnCertificates(mongooseConnection);
    const certificationPath = (await parcel.validate(trustedCertificates))!!;

    const recipientGatewayCert = certificationPath[certificationPath.length - 2];
    const privateGatewayAddress = await recipientGatewayCert.calculateSubjectPrivateAddress();
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

    await natsStreamingClient.publishMessage(key, `pdc-parcel.${privateGatewayAddress}`);
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

  public async storeEndpointBoundParcel(
    parcel: Parcel,
    parcelSerialized: Buffer,
    peerGatewayAddress: string,
    mongooseConnection: Connection,
    natsStreamingClient: NatsStreamingClient,
  ): Promise<string | null> {
    // Don't require the sender to be on a valid path from the current public gateway: Doing so
    // would only work if the recipient is also served by this gateway.
    await parcel.validate();

    if (await wasParcelCollected(parcel, peerGatewayAddress, mongooseConnection)) {
      return null;
    }

    const senderPrivateAddress = await parcel.senderCertificate.calculateSubjectPrivateAddress();
    const parcelObjectKey = `${peerGatewayAddress}/${senderPrivateAddress}/${uuid()}`;
    await this.objectStoreClient.putObject(
      { body: parcelSerialized, metadata: {} },
      makeFullInternetBoundObjectKey(parcelObjectKey),
      this.bucket,
    );

    const messageData: QueuedInternetBoundParcelMessage = {
      parcelExpiryDate: parcel.expiryDate,
      parcelObjectKey,
      parcelRecipientAddress: parcel.recipientAddress,
    };
    await natsStreamingClient.publishMessage(JSON.stringify(messageData), 'internet-parcels');

    await recordParcelCollection(parcel, peerGatewayAddress, mongooseConnection);

    return parcelObjectKey;
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
