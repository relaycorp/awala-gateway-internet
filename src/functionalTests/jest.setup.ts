jest.setTimeout(10_000);

const TEST_ENV_VARS = {
  COGRPC_REQUIRE_TLS: 'false',
};
// tslint:disable-next-line:no-object-mutation
Object.assign(process.env, TEST_ENV_VARS);
