import { connect, Message, Stan } from 'node-nats-streaming';
import { PassThrough } from 'stream';
import * as streamToIt from 'stream-to-it';
import { promisify } from 'util';

export interface PublisherMessage {
  readonly id: string;
  readonly data: Buffer;
}

export class NatsStreamingClient {
  constructor(
    protected readonly serverUrl: string,
    protected readonly clusterId: string,
    protected readonly clientId: string,
  ) {}

  public makePublisher(
    channel: string,
  ): (
    messages: IterableIterator<PublisherMessage> | readonly PublisherMessage[],
  ) => AsyncIterable<string> {
    // tslint:disable-next-line:no-let
    let didPublishingStart = false;

    const promisedConnection = this.connect();
    return async function*(messages): AsyncIterable<string> {
      if (didPublishingStart) {
        throw new Error('Publisher cannot be reused as the connection was already closed');
      }
      didPublishingStart = true;

      const connection = await promisedConnection;
      const publishPromisified = promisify(connection.publish).bind(connection);

      try {
        for (const message of messages) {
          await publishPromisified(channel, message.data);
          yield message.id;
        }
      } finally {
        connection.close();
      }
    };
  }

  public async publishMessage(messageData: Buffer, channel: string): Promise<void> {
    const publisher = this.makePublisher(channel);
    await consumeAsyncIterable(publisher([{ id: 'single-message', data: messageData }]));
  }

  public async *makeQueueConsumer(
    channel: string,
    queue: string,
    durableName: string,
  ): AsyncIterable<Message> {
    const connection = await this.connect();
    const subscriptionOptions = connection
      .subscriptionOptions()
      .setDurableName(durableName)
      .setDeliverAllAvailable()
      .setManualAckMode(true)
      .setAckWait(5_000)
      .setMaxInFlight(1);
    const sourceStream = new PassThrough({ objectMode: true });

    function gracefullyEndWorker(): void {
      sourceStream.destroy();
      process.exit(0);
    }
    process.on('SIGINT', gracefullyEndWorker);
    process.on('SIGTERM', gracefullyEndWorker);

    try {
      const subscription = connection.subscribe(channel, queue, subscriptionOptions);
      subscription.on('error', error => sourceStream.destroy(error));
      subscription.on('message', msg => sourceStream.write(msg));
      for await (const msg of streamToIt.source(sourceStream)) {
        yield msg;
      }
    } finally {
      connection.close();
      process.removeListener('SIGINT', gracefullyEndWorker);
      process.removeListener('SIGTERM', gracefullyEndWorker);
    }
  }

  public async connect(): Promise<Stan> {
    return new Promise<Stan>((resolve, _reject) => {
      const connection = connect(this.clusterId, this.clientId, { url: this.serverUrl });
      connection.on('connect', () => {
        resolve(connection);
      });
    });
  }
}

async function consumeAsyncIterable<T>(iterable: AsyncIterable<T>): Promise<void> {
  // tslint:disable-next-line:no-empty
  for await (const _ of iterable) {
  }
}
