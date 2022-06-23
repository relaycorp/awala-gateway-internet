import envVar from 'env-var';

import { processInternetBoundParcels } from '../queueWorkers/pdcOutgoing';

const { get: getEnvVar } = envVar;

async function main(): Promise<void> {
  const workerId = getEnvVar('WORKER_ID').required().asString();
  const pohttpAddress = getEnvVar('POHTTP_ADDRESS').required().asString();

  await processInternetBoundParcels(workerId, pohttpAddress);
}

main();
