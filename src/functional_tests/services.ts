/* tslint:disable:no-let */

import axios from 'axios';
import * as dockerCompose from 'docker-compose';
import { get as getEnvVar } from 'env-var';

import { OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_CLIENT, sleep } from './utils';

export const GW_GOGRPC_URL = 'http://127.0.0.1:8081/';
export const PONG_ENDPOINT_ADDRESS = 'http://pong:8080/';

const VAULT_URL = getEnvVar('VAULT_URL')
  .required()
  .asString();
const VAULT_TOKEN = getEnvVar('VAULT_TOKEN')
  .required()
  .asString();
const VAULT_KV_PREFIX = getEnvVar('VAULT_KV_PREFIX')
  .required()
  .asString();
const VAULT_CLIENT = axios.create({
  baseURL: `${VAULT_URL}/v1`,
  headers: { 'X-Vault-Token': VAULT_TOKEN },
});

// tslint:disable-next-line:readonly-array
const COMPOSE_OPTIONS = [
  '--project-name',
  'gw-functional-tests',
  '--file',
  'docker-compose.yml',
  '--file',
  'src/functional_tests/docker-compose.override.yml',
];

export function configureServices(serviceUnderTest?: string, includeVault = true): void {
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

export async function runServiceCommand(
  serviceName: string,
  // tslint:disable-next-line:readonly-array
  command: string[],
): Promise<string> {
  const result = await dockerCompose.run(serviceName, command, {
    commandOptions: ['--rm'],
    composeOptions: COMPOSE_OPTIONS,
    log: true,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Command ${command} in ${serviceName} failed`);
  }
  return result.out;
}

async function bootstrapServiceData(includeVault = true): Promise<void> {
  if (includeVault) {
    await vaultEnableSecret(VAULT_KV_PREFIX);
    await runServiceCommand('cogrpc', ['src/bin/generate-keypairs.ts']);
  }
}

export async function clearServiceData(includeVault = true): Promise<void> {
  if (includeVault) {
    await vaultDisableSecret(VAULT_KV_PREFIX);
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

async function setUpServices(mainService?: string): Promise<void> {
  if (mainService) {
    await dockerCompose.upOne(mainService, { composeOptions: COMPOSE_OPTIONS, log: true });
  } else {
    await dockerCompose.upAll({
      composeOptions: COMPOSE_OPTIONS,
      log: true,
    });
  }

  await sleep(mainService === undefined ? 7 : 4);

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

export async function vaultEnableSecret(kvPrefix: string): Promise<void> {
  await VAULT_CLIENT.post(`/sys/mounts/${kvPrefix}`, {
    options: { version: '2' },
    type: 'kv',
  });
  await VAULT_CLIENT.put(`/sys/audit/${kvPrefix}`, {
    options: {
      file_path: `/tmp/${kvPrefix}.log`,
    },
    type: 'file',
  });
}

export async function vaultDisableSecret(kvPrefix: string): Promise<void> {
  await VAULT_CLIENT.delete(`/sys/mounts/${kvPrefix}`);
}
