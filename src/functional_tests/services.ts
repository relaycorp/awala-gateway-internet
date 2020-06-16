/* tslint:disable:no-let */
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
  });
  afterAll(tearDownServices);

  beforeEach(async () => {
    await clearServiceData(includeVault);
    await sleep(1);
    await bootstrapServiceData(includeVault);
  });
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
}

export async function clearServiceData(includeVault = true): Promise<void> {
  if (includeVault) {
    await dockerCompose.exec('vault', ['vault', 'secrets', 'disable', 'gw-keys'], {
      commandOptions: ['--env', `VAULT_ADDR=${VAULT_URL}`, '--env', `VAULT_TOKEN=${VAULT_TOKEN}`],
      composeOptions: COMPOSE_OPTIONS,
      log: true,
    });
  }

  await emptyBucket(OBJECT_STORAGE_BUCKET);

  // We can't empty NATS Streaming so we'll have to restart it, which in turn requires restarting
  // the processes with clients connected to NATS.
  await restartAllServices();

  // TODO: Remove Mongo collections
}

async function emptyBucket(bucket: string): Promise<void> {
  // tslint:disable-next-line:readonly-array
  let objectKeys: string[];
  try {
    const listedObjectsResult = await OBJECT_STORAGE_CLIENT.listObjectsV2({
      Bucket: bucket,
    }).promise();
    // tslint:disable-next-line:readonly-array
    objectKeys = (listedObjectsResult.Contents?.map(o => o.Key) as string[]) || [];
  } catch (error) {
    if (error.statusCode === 404) {
      // Bucket doesn't exist
      return;
    }
    throw error;
  }

  await OBJECT_STORAGE_CLIENT.deleteObjects({
    Bucket: bucket,
    Delete: { Objects: objectKeys.map(k => ({ Key: k })) },
  }).promise();
}

async function setUpServices(mainService: string): Promise<void> {
  await dockerCompose.upOne(mainService, { composeOptions: COMPOSE_OPTIONS, log: true });

  await sleep(2);

  await OBJECT_STORAGE_CLIENT.createBucket({
    Bucket: OBJECT_STORAGE_BUCKET,
  }).promise();
}

async function tearDownServices(): Promise<void> {
  await dockerCompose.down({
    commandOptions: ['--remove-orphans'],
    composeOptions: COMPOSE_OPTIONS,
    log: true,
  });
}

export async function stopService(service: string): Promise<void> {
  await dockerCompose.stopOne(service, {
    composeOptions: COMPOSE_OPTIONS,
    log: true,
  });
}

export async function startService(service: string): Promise<void> {
  await dockerCompose.restartOne(service, {
    composeOptions: COMPOSE_OPTIONS,
    log: true,
  });
}

async function restartAllServices(): Promise<void> {
  await dockerCompose.restartAll({ composeOptions: COMPOSE_OPTIONS, log: true });
}
