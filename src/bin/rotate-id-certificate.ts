import { createMongooseConnectionFromEnv } from '../backingServices/mongo';
import { rotateOwnCertificate } from '../pki';
import { configureExitHandling } from '../utilities/exitHandling';
import { makeLogger } from '../utilities/logging';

const LOGGER = makeLogger();
configureExitHandling(LOGGER);

async function main(): Promise<void> {
  const connection = await createMongooseConnectionFromEnv();
  try {
    const newCertificate = await rotateOwnCertificate(connection);

    if (newCertificate) {
      LOGGER.info({ expiryDate: newCertificate.expiryDate }, 'Created new certificate');
    } else {
      LOGGER.debug('Existing certificate need not be rotated');
    }
  } finally {
    await connection.close();
  }
}

main();
