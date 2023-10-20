import type { CloudEvent } from 'cloudevents';

import { REQUIRED_ENV_VARS } from '../../testUtils/envVars';
import { GATEWAY_INTERNET_ADDRESS } from '../../testUtils/awala';
import { makeTestServer, type TestServerFixtureRetriever } from '../../testUtils/fastify';
import makeQueueServer from './server';
import { postEvent } from '../../testUtils/eventing/cloudEvents';
import { CE_CHANNEL } from '../../testUtils/eventing/stubs';

export const QUEUE_ENV_VARS = {
  ...REQUIRED_ENV_VARS,
  OBJECT_STORE_BUCKET: 'the-bucket',
  PUBLIC_ADDRESS: GATEWAY_INTERNET_ADDRESS,
  CE_CHANNEL,
};

export function makeMockQueueServer(): TestServerFixtureRetriever {
  return makeTestServer(makeQueueServer, QUEUE_ENV_VARS);
}

export function makeQueueEventPoster(
  fixtureRetriever: TestServerFixtureRetriever,
): (event: CloudEvent<Buffer>) => Promise<number> {
  return async (event: CloudEvent<Buffer>) => {
    const { server } = fixtureRetriever();
    return postEvent(event, server);
  };
}
