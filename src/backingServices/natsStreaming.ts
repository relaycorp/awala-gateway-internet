import { source as makeSourceAbortable } from 'abortable-iterator';
import { get as getEnvVar } from 'env-var';
import pipe from 'it-pipe';
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
    // GCP LB request ids contain slashes, which cause the Stan client rejects in the client id.
    const clientIdSanitised = clientId.replace(/\W/g, '_');
    return new NatsStreamingClient(natsServerUrl, natsClusterId, clientIdSanitised);
  }

  constructor(
    public readonly serverUrl: string,
    public readonly clusterId: string,
    public readonly clientId: string,
  ) {}

  public makePublisher(
    channel: string,
    clientIdSuffix?: string,
  ): (
    messages: AsyncIterable<PublisherMessage> | readonly PublisherMessage[],
  ) => AsyncIterable<string> {
    const promisedConnection = this.connect(clientIdSuffix);
    return async function* (messages): AsyncIterable<string> {
      const connection = await promisedConnection;
      const publishPromisified = promisify(connection.publish).bind(connection);
      try {
        for await (const message of messages) {
          await publishPromisified(channel, message.data);
          yield message.id;
        }
      } finally {
        connection.close();
      }
    };
  }

  public async publishMessage(
    messageData: Buffer | string,
    channel: string,
    clientIdSuffix?: string,
  ): Promise<void> {
    await pipe([{ data: messageData }], this.makePublisher(channel, clientIdSuffix), drainIterable);
  }

  public async *makeQueueConsumer(
    channel: string,
    queue: string,
    durableName: string,
    abortSignal?: AbortSignal,
    clientIdSuffix?: string,
  ): AsyncIterable<Message> {
    const connection = await this.connect(clientIdSuffix);
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
      // Close the subscription. Do NOT "unsubscribe" from it -- Otherwise, the durable
      // subscription would be lost: https://docs.nats.io/developing-with-nats-streaming/durables
      subscription.close();

      connection.close();
    }
  }

  /**
   * Create a new connection or reuse an existing one.
   */
  protected async connect(clientIdSuffix: string = ''): Promise<Stan> {
    const clientId = `${this.clientId}${clientIdSuffix}`;
    return new Promise<Stan>((resolve) => {
      const connection = connect(this.clusterId, clientId, { url: this.serverUrl });
      connection.on('connect', () => {
        resolve(connection);
      });
    });
  }
}

async function drainIterable(iterable: AsyncIterable<any>): Promise<void> {
  for await (const _ of iterable) {
    // Do nothing
  }
}
