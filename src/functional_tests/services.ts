/* tslint:disable:no-let */

import axios from 'axios';
import * as dockerCompose from 'docker-compose';
import { get as getEnvVar } from 'env-var';

import { IS_GITHUB, OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_CLIENT, sleep } from './utils';

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
  beforeEach(async () => {
    jest.setTimeout(30_000);

    await tearDownServices();
    await setUpServices(serviceUnderTest);
    if (IS_GITHUB) {
      // GitHub is painfully slow
      await sleep(10);
    }
    await bootstrapServiceData(includeVault);
  });

  // TODO: Remove
  afterEach(async () => {
    const result = await dockerCompose.logs([], { composeOptions: COMPOSE_OPTIONS });
    // tslint:disable-next-line:no-console
    console.log('STDOUT', result.out);
    // tslint:disable-next-line:no-console
    console.log('STDERR', result.err);
  });

  afterAll(tearDownServices);
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

async function setUpServices(mainService?: string): Promise<void> {
  if (mainService) {
    await dockerCompose.upOne(mainService, { composeOptions: COMPOSE_OPTIONS, log: true });
  } else {
    await dockerCompose.upAll({
      composeOptions: COMPOSE_OPTIONS,
      log: true,
    });
  }

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
