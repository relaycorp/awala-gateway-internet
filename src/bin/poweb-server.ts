import { runFastify } from '../services/fastify';
import { makeServer } from '../services/poweb/server';

makeServer().then(runFastify);
