import { get as getEnvVar } from 'env-var';
import { Connection, createConnection } from 'mongoose';

export async function createMongooseConnectionFromEnv(): Promise<Connection> {
  const mongoUri = getEnvVar('MONGO_URI')
    .required()
    .asString();
  return createConnection(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true });
}
