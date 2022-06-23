import envVar from 'env-var';

import { processIncomingCrcCargo } from '../queueWorkers/crcIncoming';

const { get: getEnvVar } = envVar;

const WORKER_ID = getEnvVar('WORKER_ID').required().asString();
processIncomingCrcCargo(WORKER_ID);
