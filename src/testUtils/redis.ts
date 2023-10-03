import { PassThrough } from 'stream';
import { filter, map, pipeline } from 'streaming-iterables';

import { RedisPubSubClient } from '../backingServices/RedisPubSubClient';

export const REDIS_URL = 'redis://redis.example:6379';

interface PublishedMessage {
  channel: string;
  content: string;
}

export class MockRedisPubSubClient extends RedisPubSubClient {
  protected subscriptionStream = new PassThrough({ objectMode: true });

  public override async *subscribe(channel: string): AsyncIterable<string> {
    yield* pipeline(
      () => this.subscriptionStream,
      filter((message: PublishedMessage) => message.channel === channel),
      map((message: PublishedMessage) => message.content),
    );
  }

  public mockPublish(message: PublishedMessage): void {
    this.subscriptionStream.write(message);
  }

  public reset(): void {
    this.subscriptionStream.destroy();
    this.subscriptionStream = new PassThrough({ objectMode: true });
  }
}

export function mockRedisPubSubClient(): MockRedisPubSubClient {
  const client = new MockRedisPubSubClient(REDIS_URL);
  const mockInit = jest.spyOn(RedisPubSubClient, 'init').mockReturnValue(client);

  afterEach(() => client.reset());
  afterAll(() => mockInit.mockRestore());

  return client;
}
