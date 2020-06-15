import * as dockerCompose from 'docker-compose';
import { get as getEnvVar } from 'env-var';

import { OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_CLIENT, sleep } from './utils';

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

export function configureServices(serviceUnderTest: string, includeVault = true): void {
  beforeAll(async () => {
    jest.setTimeout(15_000);
    await tearDownServices();
    await setUpServices(serviceUnderTest);
    await sleep(2);
    await bootstrapServiceData(includeVault);
  });
  afterAll(tearDownServices);
}

async function bootstrapServiceData(includeVault = true): Promise<void> {
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

async function setUpServices(service: string): Promise<void> {
  await dockerCompose.upOne(service, { composeOptions: COMPOSE_OPTIONS, log: true });
}

async function tearDownServices(): Promise<void> {
  await dockerCompose.down({
    commandOptions: ['--remove-orphans'],
    composeOptions: COMPOSE_OPTIONS,
    log: true,
  });
}
