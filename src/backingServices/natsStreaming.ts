import { source as makeSourceAbortable } from 'abortable-iterator';
import { get as getEnvVar } from 'env-var';
import { connect, Message, Stan } from 'node-nats-streaming';
import { PassThrough } from 'stream';
import * as streamToIt from 'stream-to-it';
import { promisify } from 'util';

export interface PublisherMessage {
  readonly id: string;
  readonly data: Buffer | string;
}

export class NatsStreamingClient {
  public static initFromEnv(clientId: string): NatsStreamingClient {
    const natsServerUrl = getEnvVar('NATS_SERVER_URL').required().asString();
    const natsClusterId = getEnvVar('NATS_CLUSTER_ID').required().asString();
    return new NatsStreamingClient(natsServerUrl, natsClusterId, clientId);
  }

  // tslint:disable-next-line:readonly-keyword
  protected connection?: Stan;

  constructor(
    public readonly serverUrl: string,
    public readonly clusterId: string,
    public readonly clientId: string,
  ) {}

  public makePublisher(
    channel: string,
  ): (
    messages: AsyncIterable<PublisherMessage> | readonly PublisherMessage[],
  ) => AsyncIterable<string> {
    const promisedConnection = this.connect();
    return async function* (messages): AsyncIterable<string> {
      const connection = await promisedConnection;
      const publishPromisified = promisify(connection.publish).bind(connection);

      for await (const message of messages) {
        await publishPromisified(channel, message.data);
        yield message.id;
      }
    };
  }

  public async publishMessage(messageData: Buffer | string, channel: string): Promise<void> {
    const connection = await this.connect();
    const publishPromisified = promisify(connection.publish).bind(connection);
    await publishPromisified(channel, messageData);
  }

  public async *makeQueueConsumer(
    channel: string,
    queue: string,
    durableName: string,
    abortSignal?: AbortSignal,
  ): AsyncIterable<Message> {
    const connection = await this.connect();
    const subscriptionOptions = connection
      .subscriptionOptions()
      .setDurableName(durableName)
      .setDeliverAllAvailable()
      .setManualAckMode(true)
      .setAckWait(5_000)
      .setMaxInFlight(1);
    const messagesStream = new PassThrough({ objectMode: true });

    const subscription = connection.subscribe(channel, queue, subscriptionOptions);
    subscription.on('error', (error) => messagesStream.destroy(error));
    subscription.on('message', (msg) => messagesStream.write(msg));

    const messagesIterable = streamToIt.source(messagesStream);
    const messages = abortSignal
      ? makeSourceAbortable(messagesIterable, abortSignal, { returnOnAbort: true })
      : messagesIterable;
    try {
      for await (const msg of messages) {
        yield msg;
      }
    } finally {
      subscription.close();
      // Do NOT "unsubscribe" -- Otherwise, the durable subscription would be lost
      // https://docs.nats.io/developing-with-nats-streaming/durables
    }
  }

  public disconnect(): void {
    this.connection?.close();
  }

  /**
   * Create a new connection or reuse an existing one.
   */
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
