import { Cargo, Parcel } from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import pipe from 'it-pipe';
import * as stan from 'node-nats-streaming';
import pino from 'pino';

import { NatsStreamingClient, PublisherMessage } from '../backingServices/natsStreaming';
import { initVaultKeyStore } from '../backingServices/privateKeyStore';

const logger = pino();

export async function processIncomingCrcCargo(workerName: string): Promise<void> {
  const natsStreamingClient = NatsStreamingClient.initFromEnv(workerName);
  const privateKeyStore = initVaultKeyStore();

  async function* unwrapCargoPayload(
    messages: AsyncIterable<stan.Message>,
  ): AsyncIterable<PublisherMessage> {
    for await (const message of messages) {
      const cargo = await Cargo.deserialize(bufferToArray(message.getRawData()));
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
