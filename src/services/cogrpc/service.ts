import { ServerDuplexStream } from '@grpc/grpc-js';
import { CargoDelivery, CargoDeliveryAck, CargoRelayServerMethodSet } from '@relaycorp/cogrpc';
import { Connection } from 'mongoose';
import { Logger } from 'pino';

import { initObjectStoreFromEnv } from '../../backingServices/objectStorage';
import { initPrivateKeyStore } from '../../backingServices/keystore';
import { ParcelStore } from '../../parcelStore';
import collectCargo from './methods/collectCargo';
import deliverCargo from './methods/deliverCargo';

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

  const vaultKeyStore = initPrivateKeyStore();

  const mongooseConnection = await options.getMongooseConnection();
  mongooseConnection.on('error', (err) =>
    options.baseLogger.error({ err }, 'Mongoose connection error'),
  );

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
        options.publicAddress,
        parcelStore,
        vaultKeyStore,
        options.baseLogger,
      );
    },
  };
}
