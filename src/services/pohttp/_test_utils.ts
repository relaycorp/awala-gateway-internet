import { makeTestServer, type TestServerFixtureRetriever } from '../../testUtils/fastify';
import { REQUIRED_ENV_VARS } from '../../testUtils/envVars';
import { makeServer } from './server';

export function makePoHttpTestServer(): TestServerFixtureRetriever {
  return makeTestServer(makeServer, REQUIRED_ENV_VARS);
}
