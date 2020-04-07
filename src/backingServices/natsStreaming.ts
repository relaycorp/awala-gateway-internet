import { connect, Message, Stan } from 'node-nats-streaming';
import { PassThrough } from 'stream';
import * as streamToIt from 'stream-to-it';
import { promisify } from 'util';

export interface PublisherMessage {
  readonly id: string;
  readonly data: Buffer | string;
}

export class NatsStreamingClient {
  // tslint:disable-next-line:readonly-keyword
  protected connection?: Stan;

  constructor(
    protected readonly serverUrl: string,
    protected readonly clusterId: string,
    protected readonly clientId: string,
  ) {}

  public makePublisher(
    channel: string,
  ): (
    messages: AsyncIterable<PublisherMessage> | readonly PublisherMessage[],
  ) => AsyncIterable<string> {
    const promisedConnection = this.connect();
    return async function*(messages): AsyncIterable<string> {
      const connection = await promisedConnection;
      const publishPromisified = promisify(connection.publish).bind(connection);

      for await (const message of messages) {
        await publishPromisified(channel, message.data);
        yield message.id;
      }
    };
  }

  public async publishMessage(messageData: Buffer | string, channel: string): Promise<void> {
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

    // tslint:disable-next-line:no-let
    let subscription;
    try {
      subscription = connection.subscribe(channel, queue, subscriptionOptions);
      subscription.on('error', error => sourceStream.destroy(error));
      subscription.on('message', msg => sourceStream.write(msg));
      for await (const msg of streamToIt.source(sourceStream)) {
        yield msg;
      }
    } finally {
      subscription?.close();
      process.removeListener('SIGINT', gracefullyEndWorker);
      process.removeListener('SIGTERM', gracefullyEndWorker);
    }
  }

  public disconnect(): void {
    this.connection?.close();
  }

  protected async connect(): Promise<Stan> {
    return new Promise<Stan>((resolve, _reject) => {
      if (this.connection) {
        return resolve(this.connection);
      }

      // tslint:disable-next-line:no-object-mutation
      this.connection = connect(this.clusterId, this.clientId, { url: this.serverUrl });
      this.connection.on('connect', () => {
        resolve(this.connection);
      });
      this.connection.on('close', () => {
        // tslint:disable-next-line:no-object-mutation
        this.connection = undefined;
      });
    });
  }
}

async function consumeAsyncIterable<T>(iterable: AsyncIterable<T>): Promise<void> {
  // tslint:disable-next-line:no-empty
  for await (const _ of iterable) {
  }
}
