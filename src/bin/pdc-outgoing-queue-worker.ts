import { get as getEnvVar } from 'env-var';

import { processInternetBoundParcels } from '../queueWorkers/pdcOutgoing';

async function main(): Promise<void> {
  const workerId = getEnvVar('WORKER_ID').required().asString();

  await processInternetBoundParcels(workerId);
}

main();
