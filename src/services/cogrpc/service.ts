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

import { retrieveOwnCertificates } from '../certs';
import { publishMessage } from '../nats';

interface ServiceImplementationOptions {
  readonly mongoUri: string;
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

      async function queueCargo(source: AsyncIterable<CargoDelivery>): Promise<void> {
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

          try {
            await publishMessage(delivery.cargo, 'crc-cargo');
          } catch (error) {
            return;
          }
          call.write({ id: delivery.id });
        }
      }

      await pipe(streamToIt.source(call), queueCargo);
    },
    collectCargo,
  };
}

export async function collectCargo(
  _call: grpc.ServerDuplexStream<CargoDeliveryAck, CargoDelivery>,
): Promise<void> {
  throw new Error('Unimplemented');
}
