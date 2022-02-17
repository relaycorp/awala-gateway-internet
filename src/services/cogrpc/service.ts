import * as grpc from '@grpc/grpc-js';
import { CargoDelivery, CargoDeliveryAck, CargoRelayServerMethodSet } from '@relaycorp/cogrpc';
import { Cargo } from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import pipe from 'it-pipe';
import { Connection } from 'mongoose';
import { Logger } from 'pino';
import uuid from 'uuid-random';

import { NatsStreamingClient, PublisherMessage } from '../../backingServices/natsStreaming';
import { initObjectStoreFromEnv } from '../../backingServices/objectStorage';
import { initVaultKeyStore } from '../../backingServices/vault';
import { retrieveOwnCertificates } from '../../certs';
import { ParcelStore } from '../../parcelStore';
import { INTERNAL_SERVER_ERROR } from './grpcUtils';
import collectCargo from './methods/collectCargo';

export interface ServiceImplementationOptions {
  readonly baseLogger: Logger;
  readonly getMongooseConnection: () => Promise<Connection>;
  readonly parcelStoreBucket: string;
  readonly natsServerUrl: string;
  readonly natsClusterId: string;
  readonly publicAddress: string;
}

export async function makeServiceImplementation(
  options: ServiceImplementationOptions,
): Promise<CargoRelayServerMethodSet> {
  const objectStoreClient = initObjectStoreFromEnv();
  const parcelStore = new ParcelStore(objectStoreClient, options.parcelStoreBucket);

  const vaultKeyStore = initVaultKeyStore();

  const mongooseConnection = await options.getMongooseConnection();
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
      await collectCargo(
        call,
        mongooseConnection,
        options.publicAddress,
        parcelStore,
        vaultKeyStore,
        options.baseLogger,
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

  let cargoesDelivered = 0;

  async function* validateDelivery(
    source: AsyncIterable<CargoDelivery>,
  ): AsyncIterable<PublisherMessage> {
    for await (const delivery of source) {
      let peerGatewayAddress: string | null = null;
      let cargoId: string | null = null;
      try {
        const cargo = await Cargo.deserialize(bufferToArray(delivery.cargo));
        cargoId = cargo.id;
        peerGatewayAddress = await cargo.senderCertificate.calculateSubjectPrivateAddress();
        await cargo.validate(undefined, trustedCerts);
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
    await pipe(call, validateDelivery, natsPublisher, ackDelivery);
  } catch (err) {
    logger.error({ err }, 'Failed to store cargo');
    call.emit('error', INTERNAL_SERVER_ERROR); // Also ends the call
    return;
  }

  call.end();
  logger.info({ cargoesDelivered }, 'Cargo delivery completed successfully');
}
