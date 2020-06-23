// tslint:disable-next-line:no-var-requires
require('make-promises-safe');

import { get as getEnvVar } from 'env-var';

import { processIncomingCrcCargo } from '../services/crcQueueWorker';

const WORKER_ID = getEnvVar('WORKER_ID').required().asString();
processIncomingCrcCargo(WORKER_ID);

// tslint:disable-next-line:no-console
console.log(`Starting queue worker ${WORKER_ID}`);
