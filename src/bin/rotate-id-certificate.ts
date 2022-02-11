import { createMongooseConnectionFromEnv } from '../backingServices/mongo';
import { rotateCertificate } from '../certs';
import { makeLogger } from '../utilities/logging';

const LOGGER = makeLogger();

async function main(): Promise<void> {
  const connection = await createMongooseConnectionFromEnv();
  const newCertificate = await rotateCertificate(connection);

  if (newCertificate) {
    LOGGER.info({ expiryDate: newCertificate.expiryDate }, 'Created new certificate');
  } else {
    LOGGER.debug('Existing certificate need not be rotated');
  }
}

main();
