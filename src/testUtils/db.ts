import { randomUUID } from 'crypto';
import { deleteModelWithClass } from '@typegoose/typegoose';
import { Connection, ConnectOptions, createConnection, STATES } from 'mongoose';

import * as models from '../models';

const MODEL_CLASSES = Object.values(models).filter((m) => typeof m === 'function');

// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access,no-underscore-dangle
const BASE_MONGO_URI = (global as any).__MONGO_URI__ as string;

// Ensure every Jest worker gets its own database.
export const MONGODB_URI = `${BASE_MONGO_URI}${randomUUID()}`;

export function setUpTestDBConnection(): () => Connection {
  let connection: Connection;

  const connectionOptions: ConnectOptions = { bufferCommands: false };
  const connect = () => createConnection(MONGODB_URI, connectionOptions).asPromise();

  beforeAll(async () => {
    connection = await connect();
  });

  beforeEach(async () => {
    if (connection.readyState === STATES.disconnected) {
      connection = await connect();
    }
  });

  afterEach(async () => {
    if (connection.readyState === STATES.disconnected) {
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
