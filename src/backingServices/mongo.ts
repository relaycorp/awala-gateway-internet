import envVar from 'env-var';
import { type Connection, type ConnectOptions, createConnection } from 'mongoose';

// See: https://www.mongodb.com/community/forums/t/unstable-connection-between-gcp-cloud-run-and-mongodb-atlas-2/209084/2
const MAX_IDLE_TIMEOUT_MS = 60_000;
const TIMEOUT_MS = 3000;
const TIMEOUT_CONFIG: ConnectOptions = {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  serverSelectionTimeoutMS: TIMEOUT_MS,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  connectTimeoutMS: TIMEOUT_MS,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  maxIdleTimeMS: MAX_IDLE_TIMEOUT_MS,
};

function omitUndefinedOptions(initialOptions: ConnectOptions): ConnectOptions {
  const entries = Object.entries(initialOptions).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries);
}

export function createMongooseConnectionFromEnv(): Connection {
  const mongoUri = envVar.get('MONGODB_URI').required().asString();
  const dbName = envVar.get('MONGODB_DB').asString();
  const user = envVar.get('MONGODB_USER').asString();
  const pass = envVar.get('MONGODB_PASSWORD').asString();
  const options: ConnectOptions = {
    ...omitUndefinedOptions({ dbName, user, pass }),
    ...TIMEOUT_CONFIG,
  };
  return createConnection(mongoUri, options);
}
