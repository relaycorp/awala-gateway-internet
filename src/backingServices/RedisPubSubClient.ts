/* tslint:disable:max-classes-per-file */
import envVar from 'env-var';
import { PassThrough } from 'stream';
import { createClient, type RedisClientType } from '@redis/client';

import { InternetGatewayError } from '../errors';

export class RedisPubSubError extends InternetGatewayError {}

export type RedisPublishFunction = (message: string, channel: string) => Promise<void>;

export interface RedisPublisher {
  publish: RedisPublishFunction;
  close(): Promise<void>;
}

/**
 * High-level client for Redis' PubSub functionality.
 */
export class RedisPubSubClient {
  /**
   * Initialise this client without actually connecting to a Redis server.
   */
  public static init(): RedisPubSubClient {
    const redisUrl = envVar.get('REDIS_URL').required().asString();
    return new RedisPubSubClient(redisUrl);
  }

  constructor(protected readonly redisUrl: string) {}

  /**
   * Stream messages published to the `channel`.
   *
   * @param channel
   */
  public async *subscribe(channel: string): AsyncIterable<string> {
    const redisClient = await this.connect();

    const stream = new PassThrough({ objectMode: true });
    redisClient.once('error', (error) =>
      stream.destroy(new RedisPubSubError(error, 'Redis connection closed unexpectedly')),
    );
    stream.once('close', () => redisClient.quit());
    await redisClient.subscribe(channel, (message) => stream.write(message));
    yield* stream;
  }

  /**
   * Create a publisher that also offers the ability to close the connection when done.
   */
  public async makePublisher(): Promise<RedisPublisher> {
    const redisClient = await this.connect();

    let connectionError: Error | undefined;
    redisClient.once('error', (error) => {
      connectionError = error;
    });

    async function publish(message: string, channel: string): Promise<void> {
      if (connectionError) {
        throw new RedisPubSubError(connectionError, 'Redis connection closed unexpectedly');
      }
      if (!redisClient.isOpen) {
        throw new RedisPubSubError('Redis connection is already closed');
      }
      await redisClient.publish(channel, message);
    }

    async function close(): Promise<void> {
      if (redisClient.isOpen) {
        await redisClient.quit();
      }
    }

    return { publish, close };
  }

  private async connect(): Promise<RedisClientType> {
    const redisClient = createClient({ url: this.redisUrl });
    await redisClient.connect();
    return redisClient as RedisClientType;
  }
}
