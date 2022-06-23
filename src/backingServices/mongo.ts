import envVar from 'env-var';
import mongoose from 'mongoose';

const { get: getEnvVar } = envVar;

export async function createMongooseConnectionFromEnv(): Promise<mongoose.Connection> {
  const mongoUri = getEnvVar('MONGO_URI').required().asString();
  const dbName = getEnvVar('MONGO_DB').required().asString();
  const user = getEnvVar('MONGO_USER').required().asString();
  const pass = getEnvVar('MONGO_PASSWORD').required().asString();
  const options = { dbName, pass, user };
  return mongoose.createConnection(mongoUri, options).asPromise();
}
