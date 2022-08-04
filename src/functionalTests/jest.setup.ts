jest.setTimeout(10_000);

const TEST_ENV_VARS = {
  COGRPC_REQUIRE_TLS: 'false',
  NATS_CLUSTER_ID: 'stan',
  NATS_SERVER_URL: 'nats://127.0.0.1:4222',
};
// tslint:disable-next-line:no-object-mutation
Object.assign(process.env, TEST_ENV_VARS);
