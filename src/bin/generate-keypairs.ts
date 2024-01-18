import type { Connection } from 'mongoose';

import { createMongooseConnectionFromEnv } from '../backingServices/mongo';
import { configureExitHandling } from '../utilities/exitHandling';
import { makeLogger } from '../utilities/logging';
import { InternetGatewayManager } from '../node/InternetGatewayManager';

const LOGGER = makeLogger();
configureExitHandling(LOGGER);

async function main(): Promise<void> {
  const connection = createMongooseConnectionFromEnv();
  try {
    await bootstrap(connection);
  } finally {
    await connection.close();
  }

  LOGGER.info('Done');
}

async function bootstrap(connection: Connection): Promise<void> {
  const manager = await InternetGatewayManager.init(connection);
  const gateway = await manager.getOrCreateCurrent();
  await gateway.makeInitialSessionKeyIfMissing();
}

main();
