jest.setTimeout(10_000);

const TEST_ENV_VARS = {
  COGRPC_REQUIRE_TLS: 'false',
  NATS_CLUSTER_ID: 'stan',
  NATS_SERVER_URL: 'nats://127.0.0.1:4222',
  OBJECT_STORE_ACCESS_KEY_ID: 'test-key',
  OBJECT_STORE_BUCKET: 'public-gateway',
  OBJECT_STORE_ENDPOINT: 'http://127.0.0.1:9000',
  OBJECT_STORE_SECRET_KEY: 'test-secret',
  OBJECT_STORE_TLS_ENABLED: 'false',
  POHTTP_TLS_REQUIRED: 'false',
  VAULT_KV_PREFIX: 'gw-keys',
  VAULT_TOKEN: 'root',
  VAULT_URL: 'http://127.0.0.1:8200',
};
// tslint:disable-next-line:no-object-mutation
Object.assign(process.env, TEST_ENV_VARS);
