import { get as getEnvVar } from 'env-var';
import { Client, connect, Payload } from 'ts-nats';

export async function natsConnect(): Promise<Client> {
  const natsServersString = getEnvVar('NATS_SERVERS')
    .required()
    .asString();
  const servers = natsServersString.split(' ');

  const token = getEnvVar('NATS_TOKEN').asString();

  return connect({ servers, token, payload: Payload.BINARY });
}

export async function publishMessage(subject: string, message: Buffer): Promise<void> {
  const client = await natsConnect();

  try {
    await new Promise(async (resolve, reject) => {
      client.on('error', reject);
      client.on('permissionError', reject);

      await client.publish(subject, message);

      await client.flush();
      resolve();
    });
  } finally {
    await client.close();
  }
}
