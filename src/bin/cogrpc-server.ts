// tslint:disable-next-line:no-var-requires
require('make-promises-safe');

import { runServer } from '../services/cogrpc/server';

runServer();
// tslint:disable-next-line:no-console
console.log('Ready to receive requests');
