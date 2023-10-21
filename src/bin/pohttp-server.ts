import { runFastify } from '../utilities/fastify/server';
import { makeServer } from '../services/pohttp/server';

makeServer().then(runFastify);
