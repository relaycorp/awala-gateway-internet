import { connect, Stan } from 'node-nats-streaming';
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

  protected async connect(): Promise<Stan> {
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
