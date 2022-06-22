import { get as getEnvVar } from 'env-var';
import { Connection, ConnectOptions, createConnection } from 'mongoose';

export function getMongooseConnectionArgsFromEnv(): {
  readonly uri: string;
  readonly options: ConnectOptions;
} {
  const mongoUri = getEnvVar('MONGO_URI').required().asString();
  const mongoDb = getEnvVar('MONGO_DB').required().asString();
  const mongoUser = getEnvVar('MONGO_USER').required().asString();
  const mongoPassword = getEnvVar('MONGO_PASSWORD').required().asString();
  return {
    options: {
      dbName: mongoDb,
      pass: mongoPassword,
      user: mongoUser,
    },
    uri: mongoUri,
  };
}

export async function createMongooseConnectionFromEnv(): Promise<Connection> {
  const connectionArgs = getMongooseConnectionArgsFromEnv();
  return createConnection(connectionArgs.uri, connectionArgs.options).asPromise();
}
