// tslint:disable-next-line:no-var-requires
require('make-promises-safe');

import { makeServer } from '../services/poweb/server';
import { runFastify } from '../utilities/fastify';

makeServer().then(runFastify);
