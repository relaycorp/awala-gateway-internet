import { CargoDelivery, CargoDeliveryAck, CargoRelayServerMethodSet } from '@relaycorp/cogrpc';
import { VaultPrivateKeyStore } from '@relaycorp/keystore-vault';
import {
  Cargo,
  CargoCollectionAuthorization,
  CargoMessageStream,
  Gateway,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import * as grpc from 'grpc';
import pipe from 'it-pipe';
import { Connection } from 'mongoose';
import { Logger } from 'pino';
import * as streamToIt from 'stream-to-it';
import uuid from 'uuid-random';

import { createMongooseConnectionFromEnv } from '../../backingServices/mongo';
import { NatsStreamingClient, PublisherMessage } from '../../backingServices/natsStreaming';
import { ObjectStoreClient } from '../../backingServices/objectStorage';
import { initVaultKeyStore } from '../../backingServices/privateKeyStore';
import { recordCCAFulfillment, wasCCAFulfilled } from '../ccaFulfilments';
import { retrieveOwnCertificates } from '../certs';
import { MongoPublicKeyStore } from '../MongoPublicKeyStore';
import { generatePCAs } from '../parcelCollection';
import { ParcelStore } from '../parcelStore';

const INTERNAL_SERVER_ERROR = {
  code: grpc.status.UNAVAILABLE,
  message: 'Internal server error; please try again later',
};

export interface ServiceImplementationOptions {
  readonly baseLogger: Logger;
  readonly gatewayKeyIdBase64: string;
  readonly parcelStoreBucket: string;
  readonly natsServerUrl: string;
  readonly natsClusterId: string;
  readonly cogrpcAddress: string;
}

export async function makeServiceImplementation(
  options: ServiceImplementationOptions,
): Promise<CargoRelayServerMethodSet> {
  const objectStoreClient = ObjectStoreClient.initFromEnv();
  const parcelStore = new ParcelStore(objectStoreClient, options.parcelStoreBucket);

  const currentKeyId = Buffer.from(options.gatewayKeyIdBase64, 'base64');

  const vaultKeyStore = initVaultKeyStore();

  const mongooseConnection = await createMongooseConnectionFromEnv();
  mongooseConnection.on('error', (err) =>
    options.baseLogger.error({ err }, 'Mongoose connection error'),
  );

  return {
    async deliverCargo(
      call: grpc.ServerDuplexStream<CargoDelivery, CargoDeliveryAck>,
    ): Promise<void> {
      const logger = options.baseLogger.child({
        grpcClient: call.getPeer(),
        grpcMethod: 'deliverCargo',
      });
      await deliverCargo(
        call,
        mongooseConnection,
        options.natsServerUrl,
        options.natsClusterId,
        logger,
      );
    },
    async collectCargo(
      call: grpc.ServerDuplexStream<CargoDeliveryAck, CargoDelivery>,
    ): Promise<void> {
      const logger = options.baseLogger.child({
        grpcClient: call.getPeer(),
        grpcMethod: 'collectCargo',
      });
      await collectCargo(
        call,
        mongooseConnection,
        options.cogrpcAddress,
        currentKeyId,
        parcelStore,
        vaultKeyStore,
        logger,
      );
    },
  };
}

async function deliverCargo(
  call: grpc.ServerDuplexStream<CargoDelivery, CargoDeliveryAck>,
  mongooseConnection: Connection,
  natsServerUrl: string,
  natsClusterId: string,
  logger: Logger,
): Promise<void> {
  const trustedCerts = await retrieveOwnCertificates(mongooseConnection);

  const natsClient = new NatsStreamingClient(natsServerUrl, natsClusterId, `cogrpc-${uuid()}`);
  const natsPublisher = natsClient.makePublisher('crc-cargo');

  // tslint:disable-next-line:no-let
  let cargoesDelivered = 0;

  async function* validateDelivery(
    source: AsyncIterable<CargoDelivery>,
  ): AsyncIterable<PublisherMessage> {
    for await (const delivery of source) {
      // tslint:disable-next-line:no-let
      let peerGatewayAddress: string | null = null;
      // tslint:disable-next-line:no-let
      let cargoId: string | null = null;
      try {
        const cargo = await Cargo.deserialize(bufferToArray(delivery.cargo));
        cargoId = cargo.id;
        peerGatewayAddress = await cargo.senderCertificate.calculateSubjectPrivateAddress();
        await cargo.validate(trustedCerts);
      } catch (err) {
        // Acknowledge that we got it, not that it was accepted and stored. See:
        // https://github.com/relaynet/specs/issues/38
        logger.info({ err, peerGatewayAddress }, 'Ignoring malformed/invalid cargo');
        call.write({ id: delivery.id });
        continue;
      }

      logger.info({ cargoId, peerGatewayAddress }, 'Processing valid cargo');
      cargoesDelivered += 1;
      yield { id: delivery.id, data: delivery.cargo };
    }
  }

  async function ackDelivery(source: AsyncIterable<string>): Promise<void> {
    for await (const deliveryId of source) {
      call.write({ id: deliveryId });
    }
  }

  try {
    await pipe(streamToIt.source(call), validateDelivery, natsPublisher, ackDelivery);
  } catch (err) {
    logger.error({ err }, 'Failed to store cargo');
    call.emit('error', INTERNAL_SERVER_ERROR);
    return;
  } finally {
    natsClient.disconnect();
  }

  logger.info({ cargoesDelivered }, 'Cargo delivery completed successfully');
}

async function collectCargo(
  call: grpc.ServerDuplexStream<CargoDeliveryAck, CargoDelivery>,
  mongooseConnection: Connection,
  ownCogrpcAddress: string,
  currentKeyId: Buffer,
  parcelStore: ParcelStore,
  vaultKeyStore: VaultPrivateKeyStore,
  logger: Logger,
): Promise<void> {
  const authorizationMetadata = call.metadata.get('Authorization');

  const ccaOrError = await parseAndValidateCCAFromMetadata(authorizationMetadata);
  if (ccaOrError instanceof Error) {
    logger.info({ reason: ccaOrError.message }, 'Refusing malformed/invalid CCA');
    call.emit('error', {
      code: grpc.status.UNAUTHENTICATED,
      message: ccaOrError.message,
    });
    return;
  }

  const cca = ccaOrError;
  const peerGatewayAddress = await cca.senderCertificate.calculateSubjectPrivateAddress();
  const ccaAwareLogger = logger.child({ peerGatewayAddress });

  if (cca.recipientAddress !== ownCogrpcAddress) {
    ccaAwareLogger.info(
      { ccaRecipientAddress: cca.recipientAddress },
      'Refusing CCA bound for another gateway',
    );
    call.emit('error', {
      code: grpc.status.INVALID_ARGUMENT,
      message: 'CCA recipient is a different gateway',
    });
    return;
  }

  if (await wasCCAFulfilled(cca, mongooseConnection)) {
    ccaAwareLogger.info('Refusing CCA that was already fulfilled');
    call.emit('error', {
      code: grpc.status.PERMISSION_DENIED,
      message: 'CCA was already fulfilled',
    });
    return;
  }

  // tslint:disable-next-line:no-let
  let cargoesCollected = 0;

  async function* encapsulateMessagesInCargo(messages: CargoMessageStream): AsyncIterable<Buffer> {
    const publicKeyStore = new MongoPublicKeyStore(mongooseConnection);
    const gateway = new Gateway(vaultKeyStore, publicKeyStore);
    yield* await gateway.generateCargoes(messages, cca.senderCertificate, currentKeyId);
  }

  async function sendCargoes(cargoesSerialized: AsyncIterable<Buffer>): Promise<void> {
    for await (const cargoSerialized of cargoesSerialized) {
      // We aren't keeping the delivery ids because we're currently not doing anything with the ACKs
      // In the future we might use the ACKs to support back-pressure
      const delivery: CargoDelivery = { cargo: cargoSerialized, id: uuid() };
      call.write(delivery);
      cargoesCollected += 1;
    }
  }

  const cargoMessageStream = await concatMessageStreams(
    generatePCAs(peerGatewayAddress, mongooseConnection),
    parcelStore.retrieveActiveParcelsForGateway(peerGatewayAddress),
  );
  try {
    await pipe(cargoMessageStream, encapsulateMessagesInCargo, sendCargoes);
  } catch (err) {
    ccaAwareLogger.error({ err, peerGatewayAddress }, 'Failed to send cargo');
    call.emit('error', INTERNAL_SERVER_ERROR);
    return;
  }

  await recordCCAFulfillment(cca, mongooseConnection);
  ccaAwareLogger.info({ cargoesCollected }, 'CCA was fulfilled successfully');
  call.end();
}

/**
 * Parse and validate the CCA in `authorizationMetadata`, or return an error if validation fails.
 *
 * We're returning an error instead of throwing it to distinguish validation errors from bugs.
 *
 * @param authorizationMetadata
 */
async function parseAndValidateCCAFromMetadata(
  authorizationMetadata: readonly grpc.MetadataValue[],
): Promise<CargoCollectionAuthorization | Error> {
  if (authorizationMetadata.length !== 1) {
    return new Error('Authorization metadata should be specified exactly once');
  }

  const authorization = authorizationMetadata[0] as string;
  const [authorizationType, authorizationValue] = authorization.split(' ', 2);
  if (authorizationType !== 'Relaynet-CCA') {
    return new Error('Authorization type should be Relaynet-CCA');
  }
  if (authorizationValue === undefined) {
    return new Error('Authorization value should be set to the CCA');
  }

  const ccaSerialized = Buffer.from(authorizationValue, 'base64');
  try {
    return await CargoCollectionAuthorization.deserialize(bufferToArray(ccaSerialized));
  } catch (_) {
    return new Error('CCA is malformed');
  }
}

async function* concatMessageStreams(
  ...streams: readonly CargoMessageStream[]
): CargoMessageStream {
  for (const iterable of streams) {
    yield* await iterable;
  }
}
