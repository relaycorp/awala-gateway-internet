import { runFastify } from '../services/fastify';
import { makeServer } from '../services/pohttp/server';

makeServer().then(runFastify);
