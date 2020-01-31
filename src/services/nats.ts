import { get as getEnvVar } from 'env-var';
import { Client, connect } from 'ts-nats';

export async function natsConnect(): Promise<Client> {
  const natsServersString = getEnvVar('NATS_SERVERS')
    .required()
    .asString();
  const servers = natsServersString.split(' ');

  const token = getEnvVar('NATS_TOKEN').asString();

  return connect({ servers, token });
}
