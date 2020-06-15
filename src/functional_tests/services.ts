import * as dockerCompose from 'docker-compose';
import { get as getEnvVar } from 'env-var';

import { OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_CLIENT } from './utils';

const VAULT_URL = getEnvVar('VAULT_URL')
  .required()
  .asString();
const VAULT_TOKEN = getEnvVar('VAULT_TOKEN')
  .required()
  .asString();

// tslint:disable-next-line:readonly-array
const COMPOSE_OPTIONS = [
  '--project-name',
  'gw-functional-tests',
  '--file',
  'docker-compose.yml',
  '--file',
  'src/functional_tests/docker-compose.override.yml',
];

export async function bootstrapServiceData(includeVault = true): Promise<void> {
  if (includeVault) {
    await dockerCompose.exec('vault', ['vault', 'secrets', 'enable', '-path=gw-keys', 'kv-v2'], {
      commandOptions: ['--env', `VAULT_ADDR=${VAULT_URL}`, '--env', `VAULT_TOKEN=${VAULT_TOKEN}`],
      composeOptions: COMPOSE_OPTIONS,
      log: true,
    });

    await dockerCompose.run('cogrpc', ['src/bin/generate-keypairs.ts'], {
      commandOptions: ['--rm'],
      composeOptions: COMPOSE_OPTIONS,
      log: true,
    });
  }

  await OBJECT_STORAGE_CLIENT.createBucket({
    Bucket: OBJECT_STORAGE_BUCKET,
  }).promise();
}

// tslint:disable-next-line:readonly-array
export async function setUpServices(services: string[]): Promise<void> {
  await dockerCompose.upMany(services, { composeOptions: COMPOSE_OPTIONS, log: true });
}

export async function tearDownServices(): Promise<void> {
  await dockerCompose.down({
    commandOptions: ['--remove-orphans'],
    composeOptions: COMPOSE_OPTIONS,
    log: true,
  });
}
