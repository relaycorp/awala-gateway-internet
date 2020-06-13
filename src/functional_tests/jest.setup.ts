import * as dotEnv from 'dotenv';

dotEnv.config();
// tslint:disable-next-line:no-object-mutation
Object.assign(process.env, {
  NATS_SERVER_URL: 'nats://127.0.0.1:4222',
  OBJECT_STORE_ENDPOINT: 'http://127.0.0.1:9000',
  POHTTP_TLS_REQUIRED: 'false',
  VAULT_URL: 'http://127.0.0.1:8200',
});
