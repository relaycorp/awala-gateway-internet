// tslint:disable-next-line:no-var-requires
require('make-promises-safe');

import { runServer } from '../services/cogrpc/server';

async function main(): Promise<void> {
  await runServer();
  // tslint:disable-next-line:no-console
  console.log('Ready to receive requests');
}

main();
