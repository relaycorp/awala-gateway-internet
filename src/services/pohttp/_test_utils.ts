import { makeTestServer, type TestServerFixture } from '../../testUtils/fastify';
import { REQUIRED_ENV_VARS } from '../../testUtils/envVars';
import { makeServer } from './server';

export function makePoHttpTestServer(): () => TestServerFixture {
  return makeTestServer(makeServer, REQUIRED_ENV_VARS);
}
