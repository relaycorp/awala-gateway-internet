import { makeServer } from '../services/pohttp/server';
import { runFastify } from '../utilities/fastify';

makeServer().then(runFastify);
