import {
  CargoDelivery,
  CargoDeliveryAck,
  CargoRelayServerMethodSet,
} from '@relaycorp/relaynet-cogrpc';
import { Cargo } from '@relaycorp/relaynet-core';
import * as grpc from 'grpc';
import pipe from 'it-pipe';
import { createConnection } from 'mongoose';
import * as streamToIt from 'stream-to-it';
import uuid from 'uuid-random';

import { retrieveOwnCertificates } from '../certs';
import { NatsStreamingClient, PublisherMessage } from '../natsStreaming';

interface ServiceImplementationOptions {
  readonly mongoUri: string;
  readonly natsServerUrl: string;
  readonly natsClusterId: string;
}

export function makeServiceImplementation(
  options: ServiceImplementationOptions,
): CargoRelayServerMethodSet {
  return {
    async deliverCargo(
      call: grpc.ServerDuplexStream<CargoDelivery, CargoDeliveryAck>,
    ): Promise<void> {
      const mongooseConnection = createConnection(options.mongoUri);
      const trustedCerts = await retrieveOwnCertificates(mongooseConnection);
      await mongooseConnection.close();

      call.on('end', () => {
        call.end();
      });

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
          // tslint:disable-next-line:no-let
          let cargo: Cargo;
          try {
            cargo = await Cargo.deserialize(delivery.cargo);
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

      await pipe(streamToIt.source(call), validateDelivery, natsPublisher, ackDelivery);
    },
    collectCargo,
  };
}

export async function collectCargo(
  _call: grpc.ServerDuplexStream<CargoDeliveryAck, CargoDelivery>,
): Promise<void> {
  throw new Error('Unimplemented');
}
