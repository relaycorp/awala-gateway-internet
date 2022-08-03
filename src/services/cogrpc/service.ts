import { ServerDuplexStream } from '@grpc/grpc-js';
import { CargoDelivery, CargoDeliveryAck, CargoRelayServerMethodSet } from '@relaycorp/cogrpc';
import { Connection } from 'mongoose';
import { Logger } from 'pino';

import { initPrivateKeyStore } from '../../backingServices/keystore';
import { ParcelStore } from '../../parcelStore';
import collectCargo from './methods/collectCargo';
import deliverCargo from './methods/deliverCargo';

export interface ServiceOptions {
  readonly baseLogger: Logger;
  readonly getMongooseConnection: () => Promise<Connection>;
  readonly natsServerUrl: string;
  readonly natsClusterId: string;
  readonly internetAddress: string;
}

export async function makeService(options: ServiceOptions): Promise<CargoRelayServerMethodSet> {
  const parcelStore = ParcelStore.initFromEnv();

  const mongooseConnection = await options.getMongooseConnection();
  mongooseConnection.on('error', (err) =>
    options.baseLogger.error({ err }, 'Mongoose connection error'),
  );

  const privateKeyStore = initPrivateKeyStore(mongooseConnection);

  return {
    async deliverCargo(call: ServerDuplexStream<CargoDelivery, CargoDeliveryAck>): Promise<void> {
      await deliverCargo(
        call,
        mongooseConnection,
        options.natsServerUrl,
        options.natsClusterId,
        options.baseLogger,
      );
    },
    async collectCargo(call: ServerDuplexStream<CargoDeliveryAck, CargoDelivery>): Promise<void> {
      await collectCargo(
        call,
        mongooseConnection,
        options.internetAddress,
        parcelStore,
        privateKeyStore,
        options.baseLogger,
      );
    },
  };
}
