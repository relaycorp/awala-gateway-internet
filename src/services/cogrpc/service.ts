import { VaultPrivateKeyStore } from '@relaycorp/keystore-vault';
import {
  CargoDelivery,
  CargoDeliveryAck,
  CargoRelayServerMethodSet,
} from '@relaycorp/relaynet-cogrpc';
import {
  Cargo,
  CargoCollectionAuthorization,
  CargoMessageStream,
  Gateway,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import * as grpc from 'grpc';
import pipe from 'it-pipe';
import { createConnection } from 'mongoose';
import pino from 'pino';
import * as streamToIt from 'stream-to-it';
import uuid from 'uuid-random';

import { NatsStreamingClient, PublisherMessage } from '../../backingServices/natsStreaming';
import { ObjectStoreClient } from '../../backingServices/objectStorage';
import { initVaultKeyStore } from '../../backingServices/privateKeyStore';
import { recordCCAFulfillment, wasCCAFulfilled } from '../ccaFulfilments';
import { retrieveOwnCertificates } from '../certs';
import { MongoPublicKeyStore } from '../MongoPublicKeyStore';
import { generatePCAs } from '../parcelCollectionAck';
import { ParcelStore } from '../parcelStore';

interface ServiceImplementationOptions {
  readonly gatewayKeyIdBase64: string;
  readonly parcelStoreBucket: string;
  readonly mongoUri: string;
  readonly natsServerUrl: string;
  readonly natsClusterId: string;
  readonly cogrpcAddress: string;
}

const LOGGER = pino();

export function makeServiceImplementation(
  options: ServiceImplementationOptions,
): CargoRelayServerMethodSet {
  const objectStoreClient = ObjectStoreClient.initFromEnv();
  const parcelStore = new ParcelStore(objectStoreClient, options.parcelStoreBucket);

  const currentKeyId = Buffer.from(options.gatewayKeyIdBase64, 'base64');

  const vaultKeyStore = initVaultKeyStore();

  return {
    async deliverCargo(
      call: grpc.ServerDuplexStream<CargoDelivery, CargoDeliveryAck>,
    ): Promise<void> {
      const mongooseConnection = createConnection(options.mongoUri);
      const trustedCerts = await retrieveOwnCertificates(mongooseConnection);
      await mongooseConnection.close();

      const natsClient = new NatsStreamingClient(
        options.natsServerUrl,
        options.natsClusterId,
        `cogrpc-${uuid()}`,
      );
      const natsPublisher = natsClient.makePublisher('crc-cargo');

      async function* validateDelivery(
        source: AsyncIterable<CargoDelivery>,
      ): AsyncIterable<PublisherMessage> {
        for await (const delivery of source) {
          try {
            const cargo = await Cargo.deserialize(delivery.cargo);
            await cargo.validate(trustedCerts);
          } catch (error) {
            // Acknowledge that we got it, not that it was accepted and stored. See:
            // https://github.com/relaynet/specs/issues/38
            call.write({ id: delivery.id });
            continue;
          }
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
      } finally {
        natsClient.disconnect();
      }
    },
    async collectCargo(
      call: grpc.ServerDuplexStream<CargoDeliveryAck, CargoDelivery>,
    ): Promise<void> {
      await collectCargo(
        call,
        options.mongoUri,
        options.cogrpcAddress,
        currentKeyId,
        parcelStore,
        vaultKeyStore,
      );
    },
  };
}

export async function collectCargo(
  call: grpc.ServerDuplexStream<CargoDeliveryAck, CargoDelivery>,
  mongoUri: string,
  ownCogrpcAddress: string,
  currentKeyId: Buffer,
  parcelStore: ParcelStore,
  vaultKeyStore: VaultPrivateKeyStore,
): Promise<void> {
  const authorizationMetadata = call.metadata.get('Authorization');

  // tslint:disable-next-line:no-let
  let cca: CargoCollectionAuthorization;
  try {
    cca = await parseAndValidateCCAFromMetadata(authorizationMetadata);
  } catch (error) {
    call.emit('error', {
      code: grpc.status.UNAUTHENTICATED,
      message: error.message,
    });
    return;
  }

  if (cca.recipientAddress !== ownCogrpcAddress) {
    call.emit('error', {
      code: grpc.status.INVALID_ARGUMENT,
      message: 'CCA recipient is a different gateway',
    });
    return;
  }

  const mongooseConnection = createConnection(mongoUri);
  call.on('end', () => mongooseConnection.close());

  if (await wasCCAFulfilled(cca, mongooseConnection)) {
    call.emit('error', {
      code: grpc.status.PERMISSION_DENIED,
      message: 'CCA was already fulfilled',
    });
    return;
  }

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
    }
  }

  const peerGatewayAddress = await cca.senderCertificate.calculateSubjectPrivateAddress();
  const cargoMessageStream = await concatMessageStreams(
    generatePCAs(peerGatewayAddress, mongooseConnection),
    parcelStore.retrieveActiveParcelsForGateway(peerGatewayAddress),
  );
  try {
    await pipe(cargoMessageStream, encapsulateMessagesInCargo, sendCargoes);
  } catch (err) {
    LOGGER.error({ err, peerGatewayAddress }, 'Failed to send cargo');
    call.emit('error', {
      code: grpc.status.UNAVAILABLE,
      message: 'Internal server error; please try again later',
    });
    return;
  }

  await recordCCAFulfillment(cca, mongooseConnection);
}

async function parseAndValidateCCAFromMetadata(
  authorizationMetadata: readonly grpc.MetadataValue[],
): Promise<CargoCollectionAuthorization> {
  if (authorizationMetadata.length !== 1) {
    throw new Error('Authorization metadata should be specified exactly once');
  }

  const authorization = authorizationMetadata[0] as string;
  const [authorizationType, authorizationValue] = authorization.split(' ', 2);
  if (authorizationType !== 'Relaynet-CCA') {
    throw new Error('Authorization type should be Relaynet-CCA');
  }
  if (authorizationValue === undefined) {
    throw new Error('Authorization value should be set to the CCA');
  }

  const ccaSerialized = Buffer.from(authorizationValue, 'base64');
  // tslint:disable-next-line:no-let
  let cca: CargoCollectionAuthorization;
  try {
    cca = await CargoCollectionAuthorization.deserialize(bufferToArray(ccaSerialized));
  } catch (_) {
    throw new Error('CCA is malformed');
  }

  return cca;
}

async function* concatMessageStreams(
  ...streams: readonly CargoMessageStream[]
): CargoMessageStream {
  for (const iterable of streams) {
    yield* await iterable;
  }
}
