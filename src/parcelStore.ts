import { ObjectStoreClient, StoreObject } from '@relaycorp/object-storage';
import { Parcel, RecipientAddressType } from '@relaycorp/relaynet-core';
import { get as getEnvVar } from 'env-var';
import pipe from 'it-pipe';
import { Connection } from 'mongoose';
import { Message } from 'node-nats-streaming';
import { Logger } from 'pino';
import uuid from 'uuid-random';

import { NatsStreamingClient } from './backingServices/natsStreaming';
import { initObjectStoreFromEnv } from './backingServices/objectStorage';
import { retrieveOwnCertificates } from './certs';
import { recordParcelCollection, wasParcelCollected } from './parcelCollection';
import { sha256Hex } from './utilities/crypto';
import { convertDateToTimestamp } from './utilities/time';
import { BasicLogger } from './utilities/types';

const GATEWAY_BOUND_OBJECT_KEY_PREFIX = 'parcels/gateway-bound';
const ENDPOINT_BOUND_OBJECT_KEY_PREFIX = 'parcels/endpoint-bound';
const EXPIRY_METADATA_KEY = 'parcel-expiry';

export interface QueuedInternetBoundParcelMessage {
  readonly parcelObjectKey: string;
  readonly parcelRecipientAddress: string;
  readonly parcelExpiryDate: Date;
}

export interface ParcelObjectMetadata<Extra> {
  readonly key: string;
  readonly extra: Extra;
}

export interface ParcelObject<Extra> extends ParcelObjectMetadata<Extra> {
  readonly body: Buffer;
  readonly expiryDate: Date;
}

export interface ParcelStreamMessage {
  readonly ack: () => Promise<void>;
  readonly parcelObjectKey: string;
  readonly parcelSerialized: Buffer;
}

export class ParcelStore {
  public static initFromEnv(): ParcelStore {
    const objectStoreClient = initObjectStoreFromEnv();
    const objectStoreBucket = getEnvVar('OBJECT_STORE_BUCKET').required().asString();
    return new ParcelStore(objectStoreClient, objectStoreBucket);
  }

  constructor(public objectStoreClient: ObjectStoreClient, public readonly bucket: string) {}

  /**
   * Output existing and new parcels for `peerGatewayAddress` until `abortSignal` is triggered.
   *
   * @param peerGatewayAddress
   * @param natsStreamingClient
   * @param abortSignal
   * @param logger
   */
  public async *liveStreamActiveParcelsForGateway(
    peerGatewayAddress: string,
    natsStreamingClient: NatsStreamingClient,
    abortSignal: AbortSignal,
    logger: Logger,
  ): AsyncIterable<ParcelStreamMessage> {
    const peerAwareLogger = logger.child({ peerGatewayAddress });

    const parcelMessages = natsStreamingClient.makeQueueConsumer(
      calculatePeerGatewayNATSChannel(peerGatewayAddress),
      'active-parcels',
      peerGatewayAddress,
      abortSignal,
    );

    const objectStoreClient = this.objectStoreClient;
    const bucket = this.bucket;

    async function* buildStream(
      parcelObjects: AsyncIterable<ParcelObject<Message>>,
    ): AsyncIterable<ParcelStreamMessage> {
      for await (const { extra: natsMessage, key, body } of parcelObjects) {
        yield {
          async ack(): Promise<void> {
            // Make sure not to keep a reference to the parcel serialization to let the garbage
            // collector do its magic.
            natsMessage.ack();
            await objectStoreClient.deleteObject(key, bucket);
          },
          parcelObjectKey: key,
          parcelSerialized: body,
        };
      }
    }

    yield* await pipe(
      parcelMessages,
      buildParcelObjectMetadataFromNATSMessage,
      this.makeActiveParcelRetriever(peerAwareLogger),
      buildStream,
    );
  }

  /**
   * Output existing parcels bound for `peerGatewayAddress`, ignoring new parcels received during
   * the lifespan of the function call, and giving the option to delete the parcel from each item
   * in the result.
   *
   * @param peerGatewayAddress
   * @param logger
   */
  public async *streamActiveParcelsForGateway(
    peerGatewayAddress: string,
    logger: Logger,
  ): AsyncIterable<ParcelStreamMessage> {
    const objectStoreClient = this.objectStoreClient;
    const bucket = this.bucket;
    async function* buildStream(
      parcelObjects: AsyncIterable<ParcelObject<Message>>,
    ): AsyncIterable<ParcelStreamMessage> {
      for await (const { key, body } of parcelObjects) {
        yield {
          async ack(): Promise<void> {
            // Make sure not to keep a reference to the parcel serialization to let the garbage
            // collector do its magic.
            await objectStoreClient.deleteObject(key, bucket);
          },
          parcelObjectKey: key,
          parcelSerialized: body,
        };
      }
    }

    yield* await pipe(
      this.retrieveActiveParcelsForGateway(peerGatewayAddress, logger),
      buildStream,
    );
  }

  /**
   * Output existing parcels bound for `peerGatewayAddress`, ignoring new parcels received during
   * the lifespan of the function call.
   *
   * @param peerGatewayAddress
   * @param logger
   */
  public async *retrieveActiveParcelsForGateway(
    peerGatewayAddress: string,
    logger: Logger,
  ): AsyncIterable<ParcelObject<null>> {
    const prefix = `${GATEWAY_BOUND_OBJECT_KEY_PREFIX}/${peerGatewayAddress}/`;
    yield* await pipe(
      this.objectStoreClient.listObjectKeys(prefix, this.bucket),
      buildParcelObjectMetadataFromString,
      this.makeActiveParcelRetriever(logger),
    );
  }

  public async storeParcelFromPeerGateway(
    parcel: Parcel,
    parcelSerialized: Buffer,
    peerGatewayAddress: string,
    mongooseConnection: Connection,
    natsStreamingConnection: NatsStreamingClient,
    logger: BasicLogger,
  ): Promise<string | null> {
    if (parcel.isRecipientAddressPrivate) {
      return this.storeGatewayBoundParcel(
        parcel,
        parcelSerialized,
        mongooseConnection,
        natsStreamingConnection,
        logger,
      );
    }
    return this.storeEndpointBoundParcel(
      parcel,
      parcelSerialized,
      peerGatewayAddress,
      mongooseConnection,
      natsStreamingConnection,
      logger,
    );
  }

  /**
   * Store a parcel bound for a private endpoint served by a peer gateway.
   *
   * @param parcel
   * @param parcelSerialized
   * @param mongooseConnection
   * @param natsStreamingClient
   * @param logger
   * @throws InvalidMessageException
   */
  public async storeGatewayBoundParcel(
    parcel: Parcel,
    parcelSerialized: Buffer,
    mongooseConnection: Connection,
    natsStreamingClient: NatsStreamingClient,
    logger: BasicLogger,
  ): Promise<string> {
    const trustedCertificates = await retrieveOwnCertificates(mongooseConnection);
    const certificationPath = (await parcel.validate(
      RecipientAddressType.PRIVATE,
      trustedCertificates,
    ))!!;
    logger.debug('Parcel is valid');

    const recipientGatewayCert = certificationPath[certificationPath.length - 2];
    const privateGatewayAddress = await recipientGatewayCert.calculateSubjectPrivateAddress();
    const key = calculateGatewayBoundParcelObjectKey(
      parcel.id,
      await parcel.senderCertificate.calculateSubjectPrivateAddress(),
      parcel.recipientAddress,
      privateGatewayAddress,
    );
    const keyAwareLogger = logger.child({ parcelObjectKey: key });

    await this.objectStoreClient.putObject(
      {
        body: parcelSerialized,
        metadata: { [EXPIRY_METADATA_KEY]: convertDateToTimestamp(parcel.expiryDate).toString() },
      },
      key,
      this.bucket,
    );
    keyAwareLogger.debug('Parcel object was stored successfully');

    await natsStreamingClient.publishMessage(
      key,
      calculatePeerGatewayNATSChannel(privateGatewayAddress),
    );
    keyAwareLogger.debug('Parcel storage was successfully published on NATS');

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
    const parcelKey = calculateGatewayBoundParcelObjectKey(
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

  /**
   * Store a parcel bound for a public endpoint.
   *
   * @param parcel
   * @param parcelSerialized
   * @param peerGatewayAddress
   * @param mongooseConnection
   * @param natsStreamingClient
   * @param logger
   * @throws InvalidMessageException
   */
  public async storeEndpointBoundParcel(
    parcel: Parcel,
    parcelSerialized: Buffer,
    peerGatewayAddress: string,
    mongooseConnection: Connection,
    natsStreamingClient: NatsStreamingClient,
    logger: BasicLogger,
  ): Promise<string | null> {
    // Don't require the sender to be on a valid path from the current public gateway: Doing so
    // would only work if the recipient is also served by this gateway.
    await parcel.validate();
    logger.debug('Parcel is valid');

    if (await wasParcelCollected(parcel, peerGatewayAddress, mongooseConnection)) {
      logger.debug('Parcel was previously processed');
      return null;
    }

    const senderPrivateAddress = await parcel.senderCertificate.calculateSubjectPrivateAddress();
    const parcelObjectKey = `${peerGatewayAddress}/${senderPrivateAddress}/${uuid()}`;
    const keyAwareLogger = logger.child({ parcelObjectKey });

    await this.objectStoreClient.putObject(
      { body: parcelSerialized, metadata: {} },
      makeFullInternetBoundObjectKey(parcelObjectKey),
      this.bucket,
    );
    keyAwareLogger.debug('Parcel object was successfully stored');

    const messageData: QueuedInternetBoundParcelMessage = {
      parcelExpiryDate: parcel.expiryDate,
      parcelObjectKey,
      parcelRecipientAddress: parcel.recipientAddress,
    };
    await natsStreamingClient.publishMessage(JSON.stringify(messageData), 'internet-parcels');
    keyAwareLogger.debug('Parcel storage was successfully published on NATS');

    await recordParcelCollection(parcel, peerGatewayAddress, mongooseConnection);
    keyAwareLogger.debug('Parcel storage was successfully recorded');

    return parcelObjectKey;
  }

  public async deleteEndpointBoundParcel(parcelObjectKey: string): Promise<void> {
    await this.objectStoreClient.deleteObject(
      makeFullInternetBoundObjectKey(parcelObjectKey),
      this.bucket,
    );
  }

  public makeActiveParcelRetriever<E>(
    logger: Logger,
  ): (
    parcelObjectsMetadata: AsyncIterable<ParcelObjectMetadata<E>>,
  ) => AsyncIterable<ParcelObject<E>> {
    const objectStoreClient = this.objectStoreClient;
    const bucket = this.bucket;

    async function* retrieveObjects(
      parcelObjectsMetadata: AsyncIterable<ParcelObjectMetadata<E>>,
    ): AsyncIterable<ParcelObjectMetadata<E> & { readonly object: StoreObject }> {
      for await (const parcelObjectMetadata of parcelObjectsMetadata) {
        let parcelObject: StoreObject;
        try {
          parcelObject = await objectStoreClient.getObject(parcelObjectMetadata.key, bucket);
        } catch (err) {
          logger.info(
            { err, parcelObjectKey: parcelObjectMetadata.key },
            'Parcel object could not be found; it could have been deleted since keys were retrieved',
          );
          continue;
        }

        yield { ...parcelObjectMetadata, object: parcelObject };
      }
    }

    async function* filterActiveParcels(
      objects: AsyncIterable<ParcelObjectMetadata<E> & { readonly object: StoreObject }>,
    ): AsyncIterable<ParcelObject<E>> {
      for await (const parcelObject of objects) {
        const parcelExpiryDate = getDateFromTimestamp(
          parcelObject.object.metadata[EXPIRY_METADATA_KEY],
        );
        if (parcelExpiryDate === null) {
          logger.warn(
            { parcelObjectKey: parcelObject.key },
            'Parcel object does not have a valid expiry timestamp',
          );
          continue;
        } else if (parcelExpiryDate <= new Date()) {
          logger.info(
            { parcelObjectKey: parcelObject.key, parcelExpiryDate },
            'Ignoring expired parcel',
          );
          continue;
        }
        yield {
          body: parcelObject.object.body,
          expiryDate: parcelExpiryDate,
          extra: parcelObject.extra,
          key: parcelObject.key,
        };
      }
    }

    return (parcelObjectsMetadata) =>
      pipe(parcelObjectsMetadata, retrieveObjects, filterActiveParcels);
  }
}

async function* buildParcelObjectMetadataFromNATSMessage(
  messages: AsyncIterable<Message>,
): AsyncIterable<ParcelObjectMetadata<Message>> {
  for await (const message of messages) {
    yield { key: message.getRawData().toString(), extra: message };
  }
}

async function* buildParcelObjectMetadataFromString(
  objectKeys: AsyncIterable<string>,
): AsyncIterable<ParcelObjectMetadata<null>> {
  for await (const key of objectKeys) {
    yield { key, extra: null };
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

function calculatePeerGatewayNATSChannel(peerGatewayAddress: string): string {
  return `pdc-parcel.${peerGatewayAddress}`;
}

function calculateGatewayBoundParcelObjectKey(
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
