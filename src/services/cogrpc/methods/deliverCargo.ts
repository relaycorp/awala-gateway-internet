import { ServerDuplexStream } from '@grpc/grpc-js';
import { CargoDelivery, CargoDeliveryAck } from '@relaycorp/cogrpc';
import { Cargo } from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { Connection } from 'mongoose';
import { Logger } from 'pino';
import { pipeline } from 'streaming-iterables';
import uuid from 'uuid-random';

import { NatsStreamingClient, PublisherMessage } from '../../../backingServices/natsStreaming';
import { retrieveOwnCertificates } from '../../../pki';
import { INTERNAL_SERVER_ERROR } from '../grpcUtils';

export default async function deliverCargo(
  call: ServerDuplexStream<CargoDelivery, CargoDeliveryAck>,
  mongooseConnection: Connection,
  natsServerUrl: string,
  natsClusterId: string,
  baseLogger: Logger,
): Promise<void> {
  const logger = baseLogger.child({
    grpcClient: call.getPeer(),
    grpcMethod: 'deliverCargo',
  });
  const trustedCerts = await retrieveOwnCertificates(mongooseConnection);

  const natsClient = new NatsStreamingClient(natsServerUrl, natsClusterId, `cogrpc-${uuid()}`);
  const natsPublisher = natsClient.makePublisher('crc-cargo');

  let cargoesDelivered = 0;

  async function* validateDelivery(
    source: AsyncIterable<CargoDelivery>,
  ): AsyncIterable<PublisherMessage> {
    for await (const delivery of source) {
      let privatePeerId: string | null = null;
      let cargoId: string | null = null;
      try {
        const cargo = await Cargo.deserialize(bufferToArray(delivery.cargo));
        cargoId = cargo.id;
        privatePeerId = await cargo.senderCertificate.calculateSubjectId();
        await cargo.validate(trustedCerts);
      } catch (err) {
        // Acknowledge that we got it, not that it was accepted and stored. See:
        // https://github.com/relaynet/specs/issues/38
        logger.info({ err, privatePeerId }, 'Ignoring malformed/invalid cargo');
        call.write({ id: delivery.id });
        continue;
      }

      logger.info({ cargoId, privatePeerId }, 'Processing valid cargo');
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
    await pipeline(() => call, validateDelivery, natsPublisher, ackDelivery);
  } catch (err) {
    logger.error({ err }, 'Failed to store cargo');
    call.emit('error', INTERNAL_SERVER_ERROR); // Also ends the call
    return;
  }

  call.end();
  logger.info({ cargoesDelivered }, 'Cargo delivery completed successfully');
}
