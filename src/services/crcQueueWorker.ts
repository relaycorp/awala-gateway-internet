import { VaultPrivateKeyStore } from '@relaycorp/keystore-vault';
import { Cargo, Parcel } from '@relaycorp/relaynet-core';
import { get as getEnvVar } from 'env-var';
import pipe from 'it-pipe';
import * as stan from 'node-nats-streaming';
import pino from 'pino';

import { NatsStreamingClient, PublisherMessage } from '../backingServices/natsStreaming';

const logger = pino();

export async function processIncomingCrcCargo(workerName: string): Promise<void> {
  const natsStreamingClient = initNatsStreamingClient(workerName);
  const privateKeyStore = initVaultKeyStore();

  async function* unwrapCargoPayload(
    messages: AsyncIterable<stan.Message>,
  ): AsyncIterable<PublisherMessage> {
    for await (const message of messages) {
      const cargo = await Cargo.deserialize(message.getRawData());
      const { payload } = await cargo.unwrapPayload(privateKeyStore);
      for (const parcelSerialized of payload.messages) {
        try {
          await Parcel.deserialize(parcelSerialized);
        } catch (error) {
          logger.info(
            {
              cargoId: cargo.id,
              error,
              senderAddress: await cargo.senderCertificate.calculateSubjectPrivateAddress(),
            },
            'Cargo contains an invalid message',
          );
          continue;
        }
        yield { data: Buffer.from(parcelSerialized), id: 'ignored-id' };
      }
      message.ack();
    }
  }

  const parcelPublisher = natsStreamingClient.makePublisher('crc-parcels');

  const queueConsumer = natsStreamingClient.makeQueueConsumer('crc-cargo', 'worker', 'worker');
  try {
    await pipe(queueConsumer, unwrapCargoPayload, parcelPublisher, consumeAsyncIterator);
  } finally {
    natsStreamingClient.disconnect();
  }
}

async function consumeAsyncIterator<T>(iterator: AsyncIterable<T>): Promise<void> {
  // I'm sure there's a cleaner/simpler way to create a sink iterator but I'm out of ideas.
  // tslint:disable-next-line:no-empty
  for await (const _ of iterator) {
  }
}

function initNatsStreamingClient(clientId: string): NatsStreamingClient {
  const natsServerUrl = getEnvVar('NATS_SERVER_URL')
    .required()
    .asString();
  const natsClusterId = getEnvVar('NATS_CLUSTER_ID')
    .required()
    .asString();
  return new NatsStreamingClient(natsServerUrl, natsClusterId, clientId);
}

function initVaultKeyStore(): VaultPrivateKeyStore {
  const vaultUrl = getEnvVar('VAULT_URL')
    .required()
    .asString();
  const vaultToken = getEnvVar('VAULT_TOKEN')
    .required()
    .asString();
  const vaultKvPath = getEnvVar('VAULT_KV_PREFIX')
    .required()
    .asString();
  return new VaultPrivateKeyStore(vaultUrl, vaultToken, vaultKvPath);
}
