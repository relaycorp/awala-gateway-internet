import { ObjectStoreClient, StoreObject } from '@relaycorp/object-storage';
import { Parcel } from '@relaycorp/relaynet-core';
import { source as makeSourceAbortable } from 'abortable-iterator';
import { get as getEnvVar } from 'env-var';
import { FastifyBaseLogger } from 'fastify';
import { Connection } from 'mongoose';
import { concat, pipeline } from 'streaming-iterables';

import { NatsStreamingClient } from './backingServices/natsStreaming';
import { initObjectStoreFromEnv } from './backingServices/objectStorage';
import { recordParcelCollection, wasParcelCollected } from './parcelCollection';
import { retrieveOwnCertificates } from './pki';
import { sha256Hex } from './utilities/crypto';
import { convertDateToTimestamp } from './utilities/time';
import { BasicLogger } from './utilities/types';
import { RedisPubSubClient, type RedisPublishFunction } from './backingServices/RedisPubSubClient';

const GATEWAY_BOUND_OBJECT_KEY_PREFIX = 'parcels/gateway-bound';
const ENDPOINT_BOUND_OBJECT_KEY_PREFIX = 'parcels/endpoint-bound';
const EXPIRY_METADATA_KEY = 'parcel-expiry';

export interface QueuedInternetBoundParcelMessage {
  readonly parcelId?: string; // Optional because it was introduced in July 2023
  readonly parcelObjectKey: string;
  readonly parcelRecipientAddress: string;
  readonly parcelExpiryDate: Date;
  readonly deliveryAttempts: number;
}

export interface ParcelObject {
  readonly key: string;
  readonly body: Buffer;
  readonly expiryDate: Date;
}

export interface ParcelStreamMessage {
  readonly ack: () => Promise<void>;
  readonly parcelObjectKey: string;
  readonly parcelSerialized: Buffer;
}

function makeParcelObjectKeyForInternetPeer(
  privatePeerId: string,
  senderId: string,
  parcel: Parcel,
): string {
  return [privatePeerId, senderId, parcel.recipient.id, sha256Hex(parcel.id)].join('/');
}

export class ParcelStore {
  public static initFromEnv(): ParcelStore {
    const objectStoreClient = initObjectStoreFromEnv();
    const objectStoreBucket = getEnvVar('OBJECT_STORE_BUCKET').required().asString();
    const internetAddress = getEnvVar('PUBLIC_ADDRESS').required().asString();
    return new ParcelStore(objectStoreClient, objectStoreBucket, internetAddress);
  }

  constructor(
    public objectStoreClient: ObjectStoreClient,
    public readonly bucket: string,
    public internetAddress: string,
  ) {}

  /**
   * Output existing and new parcels for `privatePeerId` until `abortSignal` is triggered,
   * excluding expired ones.
   *
   * @param privatePeerId
   * @param redisPubSubClient
   * @param abortSignal
   * @param logger
   */
  public async *liveStreamParcelsForPrivatePeer(
    privatePeerId: string,
    redisPubSubClient: RedisPubSubClient,
    abortSignal: AbortSignal,
    logger: FastifyBaseLogger,
  ): AsyncIterable<ParcelStreamMessage> {
    const peerAwareLogger = logger.child({ privatePeerId });

    const existingParcelObjectKeys = listParcelObjectKeysFromPrivateKey(
      this.objectStoreClient,
      this.bucket,
      privatePeerId,
    );
    const newParcelObjectKeys = redisPubSubClient.subscribe(
      getInternetPeerChannelName(privatePeerId),
    );
    const parcelObjectKeys = concat(existingParcelObjectKeys, newParcelObjectKeys);

    const objectStoreClient = this.objectStoreClient;
    const bucket = this.bucket;

    async function* buildStream(
      parcelObjects: AsyncIterable<ParcelObject>,
    ): AsyncIterable<ParcelStreamMessage> {
      const abortableParcelObjects = makeSourceAbortable(parcelObjects, abortSignal, {
        returnOnAbort: true,
      });
      for await (const { key, body } of abortableParcelObjects) {
        yield {
          async ack(): Promise<void> {
            await objectStoreClient.deleteObject(key, bucket);
          },
          parcelObjectKey: key,
          parcelSerialized: body,
        };
      }
    }

    yield* pipeline(
      () => parcelObjectKeys,
      this.makeActiveParcelRetriever(peerAwareLogger),
      buildStream,
    );
  }

  /**
   * Output existing parcels bound for `privatePeerId`, ignoring new parcels received during
   * the lifespan of the function call, and giving the option to delete the parcel from each item
   * in the result.
   *
   * @param privatePeerId
   * @param logger
   */
  public async *streamParcelsForPrivatePeer(
    privatePeerId: string,
    logger: FastifyBaseLogger,
  ): AsyncIterable<ParcelStreamMessage> {
    const objectStoreClient = this.objectStoreClient;
    const bucket = this.bucket;
    async function* buildStream(
      parcelObjects: AsyncIterable<ParcelObject>,
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

    yield* pipeline(() => this.retrieveParcelsForPrivatePeer(privatePeerId, logger), buildStream);
  }

  /**
   * Output existing parcels bound for `privatePeerId`, ignoring new parcels received during
   * the lifespan of the function call.
   *
   * @param privatePeerId
   * @param logger
   */
  public async *retrieveParcelsForPrivatePeer(
    privatePeerId: string,
    logger: FastifyBaseLogger,
  ): AsyncIterable<ParcelObject> {
    yield* pipeline(
      () => listParcelObjectKeysFromPrivateKey(this.objectStoreClient, this.bucket, privatePeerId),
      this.makeActiveParcelRetriever(logger),
    );
  }

  public async storeParcelFromPrivatePeer(
    parcel: Parcel,
    parcelSerialized: Buffer,
    privatePeerId: string,
    mongooseConnection: Connection,
    natsStreamingConnection: NatsStreamingClient,
    redisPublisher: RedisPublishFunction,
    logger: BasicLogger,
  ): Promise<string | null> {
    const isForAnotherPrivatePeer =
      !parcel.recipient.internetAddress ||
      parcel.recipient.internetAddress === this.internetAddress;
    if (isForAnotherPrivatePeer) {
      return this.storeParcelForPrivatePeer(
        parcel,
        parcelSerialized,
        mongooseConnection,
        redisPublisher,
        logger,
      );
    }
    return this.storeParcelForInternetPeer(
      parcel,
      parcelSerialized,
      privatePeerId,
      mongooseConnection,
      natsStreamingConnection,
      logger,
    );
  }

  /**
   * Store a parcel bound for a private endpoint served by a private peer.
   *
   * @param parcel
   * @param parcelSerialized
   * @param mongooseConnection
   * @param redisPublisher
   * @param logger
   * @throws InvalidMessageException
   */
  public async storeParcelForPrivatePeer(
    parcel: Parcel,
    parcelSerialized: Buffer,
    mongooseConnection: Connection,
    redisPublisher: RedisPublishFunction,
    logger: BasicLogger,
  ): Promise<string> {
    const trustedCertificates = await retrieveOwnCertificates(mongooseConnection);
    const certificationPath = (await parcel.validate(trustedCertificates))!!;
    logger.debug('Parcel is valid');

    const recipientGatewayCert = certificationPath[certificationPath.length - 2];
    const privateGatewayAddress = await recipientGatewayCert.calculateSubjectId();
    const key = makeParcelObjectKeyForPrivatePeer(
      parcel.id,
      await parcel.senderCertificate.calculateSubjectId(),
      parcel.recipient.id,
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

    await redisPublisher(key, getInternetPeerChannelName(privateGatewayAddress));
    keyAwareLogger.debug('Parcel storage was successfully published on Redis PubSub');

    return key;
  }

  /**
   * Delete specified parcel if it exists.
   *
   * @param parcelId
   * @param senderId
   * @param recipientAddress
   * @param recipientGatewayAddress
   */
  public async deleteParcelForPrivatePeer(
    parcelId: string,
    senderId: string,
    recipientAddress: string,
    recipientGatewayAddress: string,
  ): Promise<void> {
    const parcelKey = makeParcelObjectKeyForPrivatePeer(
      parcelId,
      senderId,
      recipientAddress,
      recipientGatewayAddress,
    );
    await this.objectStoreClient.deleteObject(parcelKey, this.bucket);
  }

  public async retrieveParcelForInternetPeer(parcelObjectKey: string): Promise<Buffer | null> {
    const storeObject = await this.objectStoreClient.getObject(
      makeFullObjectKeyForInternetPeer(parcelObjectKey),
      this.bucket,
    );
    return storeObject?.body ?? null;
  }

  /**
   * Store a parcel bound for a public endpoint.
   *
   * @param parcel
   * @param parcelSerialized
   * @param privatePeerId
   * @param mongooseConnection
   * @param natsStreamingClient
   * @param logger
   * @throws InvalidMessageException
   */
  public async storeParcelForInternetPeer(
    parcel: Parcel,
    parcelSerialized: Buffer,
    privatePeerId: string,
    mongooseConnection: Connection,
    natsStreamingClient: NatsStreamingClient,
    logger: BasicLogger,
  ): Promise<string | null> {
    // Don't require the sender to be on a valid path from the current Internet gateway: Doing so
    // would only work if the recipient is also served by this gateway.
    await parcel.validate();
    logger.debug('Parcel is valid');

    if (await wasParcelCollected(parcel, privatePeerId, mongooseConnection)) {
      logger.debug('Parcel was previously processed');
      return null;
    }

    const senderId = await parcel.senderCertificate.calculateSubjectId();
    const parcelObjectKey = makeParcelObjectKeyForInternetPeer(privatePeerId, senderId, parcel);
    const keyAwareLogger = logger.child({ parcelObjectKey });

    await this.objectStoreClient.putObject(
      { body: parcelSerialized, metadata: {} },
      makeFullObjectKeyForInternetPeer(parcelObjectKey),
      this.bucket,
    );
    keyAwareLogger.debug('Parcel object was successfully stored');

    const messageData: QueuedInternetBoundParcelMessage = {
      deliveryAttempts: 0,
      parcelExpiryDate: parcel.expiryDate,
      parcelId: parcel.id,
      parcelObjectKey,
      parcelRecipientAddress: parcel.recipient.internetAddress!,
    };
    await natsStreamingClient.publishMessage(JSON.stringify(messageData), 'internet-parcels');
    keyAwareLogger.debug('Parcel storage was successfully published on NATS');

    await recordParcelCollection(parcel, privatePeerId, mongooseConnection);
    keyAwareLogger.debug('Parcel storage was successfully recorded');

    return parcelObjectKey;
  }

  public async deleteParcelForInternetPeer(parcelObjectKey: string): Promise<void> {
    await this.objectStoreClient.deleteObject(
      makeFullObjectKeyForInternetPeer(parcelObjectKey),
      this.bucket,
    );
  }

  public makeActiveParcelRetriever(
    logger: FastifyBaseLogger,
  ): (parcelObjectKeys: AsyncIterable<string>) => AsyncIterable<ParcelObject> {
    const objectStoreClient = this.objectStoreClient;
    const bucket = this.bucket;

    async function* retrieveObjects(
      parcelObjectKeys: AsyncIterable<string>,
    ): AsyncIterable<{ readonly key: string; readonly object: StoreObject }> {
      for await (const parcelObjectKey of parcelObjectKeys) {
        const parcelObject = await objectStoreClient.getObject(parcelObjectKey, bucket);
        if (!parcelObject) {
          logger.info(
            { parcelObjectKey },
            'Parcel object could not be found; it could have been deleted since keys were retrieved',
          );
          continue;
        }

        yield { key: parcelObjectKey, object: parcelObject };
      }
    }

    async function* filterActiveParcels(
      objects: AsyncIterable<{ readonly key: string; readonly object: StoreObject }>,
    ): AsyncIterable<ParcelObject> {
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
          key: parcelObject.key,
        };
      }
    }

    return (parcelObjectKeys) =>
      pipeline(() => parcelObjectKeys, retrieveObjects, filterActiveParcels);
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

function makeFullObjectKeyForInternetPeer(parcelObjectKey: string): string {
  return `${ENDPOINT_BOUND_OBJECT_KEY_PREFIX}/${parcelObjectKey}`;
}

function getInternetPeerChannelName(privatePeerId: string): string {
  return `pdc-parcel.${privatePeerId}`;
}

function makeParcelObjectKeyForPrivatePeer(
  parcelId: string,
  senderId: string,
  recipientAddress: string,
  recipientGatewayAddress: string,
): string {
  return [
    GATEWAY_BOUND_OBJECT_KEY_PREFIX,
    recipientGatewayAddress,
    recipientAddress,
    senderId,
    sha256Hex(parcelId), // Use the digest to avoid using potentially illegal characters
  ].join('/');
}

async function* listParcelObjectKeysFromPrivateKey(
  objectStoreClient: ObjectStoreClient,
  bucket: string,
  privatePeerId: string,
): AsyncIterable<string> {
  const prefix = `${GATEWAY_BOUND_OBJECT_KEY_PREFIX}/${privatePeerId}/`;
  yield* objectStoreClient.listObjectKeys(prefix, bucket);
}
