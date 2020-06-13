import * as dockerCompose from 'docker-compose';
import { get as getEnvVar } from 'env-var';

import { OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_CLIENT } from './utils';

const VAULT_URL = getEnvVar('VAULT_URL')
  .required()
  .asString();
const VAULT_TOKEN = getEnvVar('VAULT_TOKEN')
  .required()
  .asString();

export async function bootstrapServiceData(): Promise<void> {
  await dockerCompose.exec('vault', ['vault', 'secrets', 'enable', '-path=gw-keys', 'kv-v2'], {
    commandOptions: ['--env', `VAULT_ADDR=${VAULT_URL}`, '--env', `VAULT_TOKEN=${VAULT_TOKEN}`],
    log: true,
  });

  await OBJECT_STORAGE_CLIENT.createBucket({
    Bucket: OBJECT_STORAGE_BUCKET,
  }).promise();

  await dockerCompose.run('cogrpc', ['src/bin/generate-keypairs.ts'], {
    commandOptions: ['--rm'],
    log: true,
  });
}

// tslint:disable-next-line:readonly-array
export async function setUpServices(services: string[]): Promise<void> {
  await dockerCompose.upMany(services, { log: true });
}

export async function tearDownServices(): Promise<void> {
  await dockerCompose.down({ commandOptions: ['--remove-orphans'], log: true });
}
