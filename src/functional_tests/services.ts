/* tslint:disable:no-let */

import axios from 'axios';
import * as dockerCompose from 'docker-compose';
import { get as getEnvVar } from 'env-var';

import { IS_GITHUB, OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_CLIENT, sleep } from './utils';

export const GW_GOGRPC_URL = 'http://127.0.0.1:8081/';
export const PONG_ENDPOINT_ADDRESS = 'http://pong:8080/';

const VAULT_URL = getEnvVar('VAULT_URL').required().asString();
const VAULT_TOKEN = getEnvVar('VAULT_TOKEN').required().asString();
const VAULT_KV_PREFIX = getEnvVar('VAULT_KV_PREFIX').required().asString();

// tslint:disable-next-line:readonly-array
const COMPOSE_OPTIONS = [
  '--project-name',
  'gw-functional-tests',
  '--file',
  'docker-compose.yml',
  '--file',
  'src/functional_tests/docker-compose.override.yml',
];

export function configureServices(): void {
  beforeEach(async () => {
    jest.setTimeout(30_000);

    await tearDownServices();
    await setUpServices();
    if (IS_GITHUB) {
      // GitHub is painfully slow
      await sleep(3);
    }
    await bootstrapServiceData();
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

async function bootstrapServiceData(): Promise<void> {
  await vaultEnableSecret(VAULT_KV_PREFIX);
  await runServiceCommand('cogrpc', ['src/bin/generate-keypairs.ts']);

  await OBJECT_STORAGE_CLIENT.createBucket({
    Bucket: OBJECT_STORAGE_BUCKET,
  }).promise();
}

async function setUpServices(): Promise<void> {
  await dockerCompose.upAll({
    composeOptions: COMPOSE_OPTIONS,
    log: true,
  });
}

async function tearDownServices(): Promise<void> {
  await dockerCompose.down({
    commandOptions: ['--remove-orphans', '--volumes'],
    composeOptions: COMPOSE_OPTIONS,
    log: true,
  });
}

export async function vaultEnableSecret(kvPrefix: string): Promise<void> {
  const vaultClient = axios.create({
    baseURL: `${VAULT_URL}/v1`,
    headers: { 'X-Vault-Token': VAULT_TOKEN },
  });
  await vaultClient.post(`/sys/mounts/${kvPrefix}`, {
    options: { version: '2' },
    type: 'kv',
  });
  await vaultClient.put(`/sys/audit/${kvPrefix}`, {
    options: {
      file_path: `/tmp/${kvPrefix}.log`,
    },
    type: 'file',
  });
}
