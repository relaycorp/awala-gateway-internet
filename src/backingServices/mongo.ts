import { get as getEnvVar } from 'env-var';
import { Connection, createConnection } from 'mongoose';

export async function createMongooseConnectionFromEnv(): Promise<Connection> {
  const mongoUri = getEnvVar('MONGO_URI').required().asString();
  const dbName = getEnvVar('MONGO_DB').required().asString();
  const user = getEnvVar('MONGO_USER').required().asString();
  const pass = getEnvVar('MONGO_PASSWORD').required().asString();
  const options = { dbName, pass, user };
  return createConnection(mongoUri, options).asPromise();
}
