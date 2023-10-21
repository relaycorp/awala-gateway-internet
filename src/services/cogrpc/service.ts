import { ServerDuplexStream } from '@grpc/grpc-js';
import { CargoDelivery, CargoDeliveryAck, CargoRelayServerMethodSet } from '@relaycorp/cogrpc';
import { Connection } from 'mongoose';
import { Logger } from 'pino';

import { initPrivateKeyStore } from '../../backingServices/keystore';
import { ParcelStore } from '../../parcelStore';
import collectCargo from './methods/collectCargo';
import deliverCargo from './methods/deliverCargo';
import type { QueueEmitter } from '../../utilities/backgroundQueue/QueueEmitter';

export interface ServiceOptions {
  readonly baseLogger: Logger;
  readonly getMongooseConnection: () => Connection;
  readonly queueEmitter: QueueEmitter;
}

export async function makeService(options: ServiceOptions): Promise<CargoRelayServerMethodSet> {
  const parcelStore = ParcelStore.initFromEnv();

  const mongooseConnection = options.getMongooseConnection();

  const privateKeyStore = initPrivateKeyStore(mongooseConnection);

  return {
    async deliverCargo(call: ServerDuplexStream<CargoDelivery, CargoDeliveryAck>): Promise<void> {
      await deliverCargo(call, mongooseConnection, options.queueEmitter, options.baseLogger);
    },
    async collectCargo(call: ServerDuplexStream<CargoDeliveryAck, CargoDelivery>): Promise<void> {
      await collectCargo(
        call,
        mongooseConnection,
        parcelStore,
        privateKeyStore,
        options.baseLogger,
      );
    },
  };
}
