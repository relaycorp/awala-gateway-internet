/* tslint:disable:no-let */

import axios from 'axios';
import * as dockerCompose from 'docker-compose';
import { get as getEnvVar } from 'env-var';

import { IS_GITHUB, OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_CLIENT, sleep } from './utils';

export const GW_POHTTP_URL = 'http://127.0.0.1:8080';
export const GW_GOGRPC_URL = 'https://127.0.0.1:8081/';
export const GW_POWEB_LOCAL_PORT = 8082;
export const PONG_ENDPOINT_ADDRESS = 'http://pong:8080/';

const VAULT_URL = getEnvVar('VAULT_URL').required().asString();
const VAULT_TOKEN = getEnvVar('VAULT_TOKEN').required().asString();
const VAULT_KV_PREFIX = getEnvVar('VAULT_KV_PREFIX').required().asString();

const BACKING_SERVICES: readonly string[] = ['mongodb', 'nats', 'vault', 'object-store'];

// tslint:disable-next-line:readonly-array
const COMPOSE_OPTIONS = [
  '--project-name',
  'gw-functional-tests',
  '--file',
  'docker-compose.yml',
  '--file',
  'src/functional_tests/docker-compose.override.yml',
];

export function configureServices(servicesToLog?: readonly string[]): void {
  beforeEach(async () => {
    jest.setTimeout(30_000);

    await tearDownServices(); // In case service are still running from a previous run

    await startServices(BACKING_SERVICES);
    await sleep(IS_GITHUB ? 5 : 1); // GitHub is painfully slow
    await bootstrapBackingServices();

    // Start the remaining services
    await startServices();
    await sleep(IS_GITHUB ? 2 : 1);
  });

  afterEach(async () => {
    // Output logs for select services. Useful if something went wrong.
    if (servicesToLog) {
      // tslint:disable-next-line:readonly-array
      await dockerCompose.logs(servicesToLog as string[], {
        composeOptions: COMPOSE_OPTIONS,
        log: true,
      });
    }

    // Shut down all service to force all open connections to close
    await tearDownServices();
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

async function bootstrapBackingServices(): Promise<void> {
  await vaultEnableSecret(VAULT_KV_PREFIX);
  await runServiceCommand('cogrpc', ['build/main/bin/generate-keypairs.js']);

  await OBJECT_STORAGE_CLIENT.createBucket({
    Bucket: OBJECT_STORAGE_BUCKET,
  }).promise();
}

async function startServices(services?: readonly string[]): Promise<void> {
  const options = { composeOptions: COMPOSE_OPTIONS, log: true };
  if (services) {
    // tslint:disable-next-line:readonly-array
    await dockerCompose.upMany(services as string[], options);
  } else {
    await dockerCompose.upAll(options);
  }
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
