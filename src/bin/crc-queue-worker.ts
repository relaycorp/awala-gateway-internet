import { get as getEnvVar } from 'env-var';

import { processIncomingCrcCargo } from '../queueWorkers/crcIncoming';

const WORKER_ID = getEnvVar('WORKER_ID').required().asString();
processIncomingCrcCargo(WORKER_ID);
