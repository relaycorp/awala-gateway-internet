import { Stan } from 'node-nats-streaming';

import { configureServices } from './services';
import { connectToNatsStreaming } from './utils';

configureServices('cogrpc');

// tslint:disable-next-line:no-let
let stanConnection: Stan;
beforeEach(async () => (stanConnection = await connectToNatsStreaming()));
afterEach(async () => stanConnection.close());

describe('Cargo delivery', () => {
  test.todo('Authorized cargo should be accepted');

  test.todo('Unauthorized cargo should be refused');
});

describe('Cargo collection', () => {
  test.todo('Authorized CCA should be accepted');

  test.todo('Unauthorized CCA should be refused');
});
