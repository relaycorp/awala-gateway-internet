import { makeServer } from '../services/poweb/server';
import { runFastify } from '../utilities/fastify';

makeServer().then(runFastify);
