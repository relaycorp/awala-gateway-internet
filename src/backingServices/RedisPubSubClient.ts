/* tslint:disable:max-classes-per-file */
import envVar from 'env-var';
import { PassThrough } from 'stream';
import { createClient } from '@redis/client';

import { InternetGatewayError } from '../errors';

export class RedisPubSubError extends InternetGatewayError {}

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

  protected constructor(protected readonly redisUrl: string) {}

  /**
   * Stream messages published to the `channel`.
   *
   * @param channel
   */
  public async *subscribe(channel: string): AsyncIterable<string> {
    const redisClient = createClient({ url: this.redisUrl });
    await redisClient.connect();

    const stream = new PassThrough({ objectMode: true });
    redisClient.once('error', (error) =>
      stream.destroy(new RedisPubSubError(error, 'Redis connection closed unexpectedly')),
    );
    stream.once('close', () => redisClient.quit());
    await redisClient.subscribe(channel, (message) => stream.write(message));
    yield* stream;
  }
}
