import {
  CargoDelivery,
  CargoDeliveryAck,
  CargoRelayServerMethodSet,
} from '@relaycorp/relaynet-cogrpc';
import { Cargo } from '@relaycorp/relaynet-core';
import * as grpc from 'grpc';
import { createConnection } from 'mongoose';

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

      call.on(
        'data',
        async (delivery: CargoDelivery): Promise<void> => {
          // tslint:disable-next-line:no-let
          let cargo: Cargo;
          try {
            cargo = await Cargo.deserialize(delivery.cargo);
            await cargo.validate(trustedCerts);
          } catch (error) {
            call.write({ id: delivery.id });
            return;
          }

          try {
            await publishMessage(delivery.cargo, 'crc-cargo');
          } catch (error) {
            return;
          }
          call.write({ id: delivery.id });
        },
      );

      call.on('end', () => {
        call.end();
      });
    },
    collectCargo,
  };
}

export async function collectCargo(
  _call: grpc.ServerDuplexStream<CargoDeliveryAck, CargoDelivery>,
): Promise<void> {
  throw new Error('Unimplemented');
}
