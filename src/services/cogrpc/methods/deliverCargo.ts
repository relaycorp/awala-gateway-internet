import { ServerDuplexStream } from '@grpc/grpc-js';
import { CargoDelivery, CargoDeliveryAck } from '@relaycorp/cogrpc';
import { Cargo } from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { CloudEvent } from 'cloudevents';
import { Connection } from 'mongoose';
import { Logger } from 'pino';
import { pipeline } from 'streaming-iterables';

import { retrieveOwnCertificates } from '../../../pki';
import { INTERNAL_SERVER_ERROR } from '../grpcUtils';
import type { QueueEmitter } from '../../../utilities/backgroundQueue/QueueEmitter';
import { EVENT_TYPES } from '../../queue/sinks/types';

interface ValidatedCargoDelivery {
  readonly privatePeerId: string;
  readonly cargoId: string;
  readonly cargoSerialised: Buffer;
  readonly deliveryId: string;
}

export default async function deliverCargo(
  call: ServerDuplexStream<CargoDelivery, CargoDeliveryAck>,
  mongooseConnection: Connection,
  queueEmitter: QueueEmitter,
  baseLogger: Logger,
): Promise<void> {
  const logger = baseLogger.child({
    grpcClient: call.getPeer(),
    grpcMethod: 'deliverCargo',
  });
  const trustedCerts = await retrieveOwnCertificates(mongooseConnection);

  let cargoesDelivered = 0;

  async function* validateDelivery(
    source: AsyncIterable<CargoDelivery>,
  ): AsyncIterable<ValidatedCargoDelivery> {
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
        // https://github.com/AwalaNetwork/specs/issues/38
        logger.info({ err, privatePeerId }, 'Ignoring malformed/invalid cargo');
        call.write({ id: delivery.id });
        continue;
      }

      logger.info({ cargoId, privatePeerId }, 'Processing valid cargo');
      cargoesDelivered += 1;
      yield { privatePeerId, cargoId, cargoSerialised: delivery.cargo, deliveryId: delivery.id };
    }
  }

  async function processDelivery(deliveries: AsyncIterable<ValidatedCargoDelivery>): Promise<void> {
    for await (const delivery of deliveries) {
      const cargoDeliveryEvent = new CloudEvent({
        type: EVENT_TYPES.CRC_INCOMING_CARGO,
        source: delivery.privatePeerId,
        subject: delivery.cargoId,
        datacontenttype: 'application/vnd.awala.cargo',
        data: delivery.cargoSerialised,
      });
      await queueEmitter.emit(cargoDeliveryEvent);

      call.write({ id: delivery.deliveryId });
    }
  }

  try {
    await pipeline(() => call, validateDelivery, processDelivery);
  } catch (err) {
    logger.error({ err }, 'Failed to store cargo');
    call.emit('error', INTERNAL_SERVER_ERROR); // Also ends the call
    return;
  }

  call.end();
  logger.info({ cargoesDelivered }, 'Cargo delivery completed successfully');
}
