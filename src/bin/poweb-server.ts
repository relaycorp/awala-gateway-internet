import { runFastify } from '../utilities/fastify/server';
import { makeServer } from '../services/poweb/server';

makeServer().then(runFastify);
