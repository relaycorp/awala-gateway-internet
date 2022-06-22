import { deleteModelWithClass } from '@typegoose/typegoose';
import { Connection, ConnectOptions, createConnection } from 'mongoose';
import * as mongoUtils from '../backingServices/mongo';

import * as models from '../models';
import { mockSpy } from './jest';

const MODEL_CLASSES = Object.values(models).filter((m) => typeof m === 'function');

export function setUpTestDBConnection(): () => Connection {
  let connection: Connection;

  mockSpy(jest.spyOn(mongoUtils, 'createMongooseConnectionFromEnv'), () => connection);

  const connectionOptions: ConnectOptions = { bufferCommands: false };
  const connect = () =>
    createConnection((global as any).__MONGO_URI__, connectionOptions).asPromise();

  beforeAll(async () => {
    connection = await connect();
  });

  beforeEach(async () => {
    if (connection.readyState === 0) {
      connection = await connect();
    }
  });

  afterEach(async () => {
    if (connection.readyState === 0) {
      // The test closed the connection, so we shouldn't just reconnect, but also purge TypeGoose'
      // model cache because every item there is bound to the old connection.
      MODEL_CLASSES.forEach(deleteModelWithClass);
      connection = await connect();
    }

    await Promise.all(Object.values(connection.collections).map((c) => c.deleteMany({})));
  });

  afterAll(async () => {
    await connection.close(true);
  });

  return () => connection;
}
