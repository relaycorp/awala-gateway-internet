import { runFastify } from '../utilities/fastify/server';
import makeQueueServer from '../services/queue/server';

makeQueueServer().then(runFastify);
