// tslint:disable-next-line:no-var-requires
require('make-promises-safe');

import { runFastify } from '../services/fastifyUtils';
import { makeServer } from '../services/poweb/server';

makeServer().then(runFastify);
