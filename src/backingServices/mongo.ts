import { PublicKeyStore } from '@relaycorp/relaynet-core';
import { get as getEnvVar } from 'env-var';
import { Connection, ConnectionOptions, createConnection } from 'mongoose';
import { MongoPublicKeyStore } from '../MongoPublicKeyStore';

export function getMongooseConnectionArgsFromEnv(): {
  readonly uri: string;
  readonly options: ConnectionOptions;
} {
  const mongoUri = getEnvVar('MONGO_URI').required().asString();
  const mongoDb = getEnvVar('MONGO_DB').required().asString();
  const mongoUser = getEnvVar('MONGO_USER').required().asString();
  const mongoPassword = getEnvVar('MONGO_PASSWORD').required().asString();
  return {
    options: {
      dbName: mongoDb,
      pass: mongoPassword,
      useNewUrlParser: true,
      useUnifiedTopology: true,
      user: mongoUser,
    },
    uri: mongoUri,
  };
}

export async function createMongooseConnectionFromEnv(): Promise<Connection> {
  const connectionArgs = getMongooseConnectionArgsFromEnv();
  return createConnection(connectionArgs.uri, connectionArgs.options);
}

/**
 * Return the public key store used by the gateway.
 *
 * @param connection
 *
 * This function exists primarily to make it easy to replace the MongoDB store with a mock one in
 * unit tests.
 */
export function initMongoDBKeyStore(connection: Connection): PublicKeyStore {
  return new MongoPublicKeyStore(connection);
}
