import { EventEmitter } from 'events';
// tslint:disable-next-line:no-submodule-imports
import { setImmediate } from 'timers/promises';
import envVar from 'env-var';
import { collect, consume, take } from 'streaming-iterables';
// tslint:disable-next-line:no-submodule-imports
import type { PubSubListener } from '@redis/client/dist/lib/client/pub-sub.js';

import { configureMockEnvVars } from '../testUtils/envVars';
import { getPromiseRejection, mockSpy } from '../testUtils/jest';

const mockCreateClient = mockSpy(jest.fn(), () => new MockRedisClient());
jest.mock('@redis/client', () => ({
  createClient: mockCreateClient,
}));
import { RedisPubSubClient, RedisPubSubError } from './RedisPubSubClient';
import { REDIS_URL } from '../testUtils/redis';

describe('RedisPubSubClient', () => {
  const mockEnvVars = configureMockEnvVars({ REDIS_URL });
  const channel = 'the channel';

  describe('init', () => {
    test('REDIS_URL should be set', () => {
      mockEnvVars({ REDIS_URL: undefined });

      expect(() => RedisPubSubClient.init()).toThrowWithMessage(envVar.EnvVarError, /REDIS_URL/);
    });
  });

  describe('subscribe', () => {
    test('Should connect to the REDIS_URL', async () => {
      const client = RedisPubSubClient.init();
      emitMessagesAsync(['message']);

      await consume(take(1, client.subscribe(channel)));

      expect(mockCreateClient).toHaveBeenCalledWith({ url: REDIS_URL });
    });

    test('Should wait for connection to be established', async () => {
      const client = RedisPubSubClient.init();
      emitMessagesAsync(['message']);

      await consume(take(1, client.subscribe(channel)));

      const redisClient = getMockedRedisClient();
      expect(redisClient.connect).toHaveBeenCalledBefore(redisClient.subscribe);
    });

    test('Should subscribe to specified channel', async () => {
      const client = RedisPubSubClient.init();
      emitMessagesAsync(['message']);

      await consume(take(1, client.subscribe(channel)));

      const redisClient = getMockedRedisClient();
      expect(redisClient.subscribe).toHaveBeenCalledWith(channel, expect.anything());
    });

    test('One message should be output if one message is published', async () => {
      const client = RedisPubSubClient.init();
      const message = 'the message';
      emitMessagesAsync([message]);

      const [collectedMessage] = await collect(take(1, client.subscribe(channel)));

      expect(collectedMessage).toBe(message);
    });

    test('Multiple messages should be output if multiple messages are published', async () => {
      const client = RedisPubSubClient.init();
      const messages = ['message 1', 'message 2', 'message 3'];
      emitMessagesAsync(messages);

      const collectedMessages = await collect(take(messages.length, client.subscribe(channel)));

      expect(collectedMessages).toStrictEqual(messages);
    });

    test('Iterable should error out when the connection ends unexpectedly', async () => {
      const client = RedisPubSubClient.init();
      const error = new Error('the error');
      setImmediate().then(() => {
        const redisClient = getMockedRedisClient();
        redisClient.emit('error', error);
      });

      const errorWrapped = await getPromiseRejection(
        collect(client.subscribe(channel)),
        RedisPubSubError,
      );

      expect(errorWrapped.message).toStartWith('Redis connection closed unexpectedly');
      expect(errorWrapped.cause()).toBe(error);
    });

    test('Should disconnect when done', async () => {
      const client = RedisPubSubClient.init();
      emitMessagesAsync(['message']);

      await consume(take(1, client.subscribe(channel)));

      const redisClient = getMockedRedisClient();
      await setImmediate();
      expect(redisClient.quit).toHaveBeenCalledOnce();
    });

    function emitMessagesAsync(messages: string[]): void {
      setImmediate().then(() => {
        const redisClient = getMockedRedisClient();
        expect(redisClient.subscribe).toHaveBeenCalledOnce();
        const [subscriptionCall] = redisClient.subscribe.mock.calls;
        const [channel, listener]: [string, PubSubListener] = subscriptionCall;
        messages.forEach((message) => listener(message, channel));
      });
    }
  });

  describe('makePublisher', () => {
    test('Should connect to the REDIS_URL', async () => {
      const client = RedisPubSubClient.init();

      await client.makePublisher();

      expect(mockCreateClient).toHaveBeenCalledWith({ url: REDIS_URL });
    });

    test('Should wait for connection to be established', async () => {
      const client = RedisPubSubClient.init();

      await client.makePublisher();

      const redisClient = getMockedRedisClient();
      expect(redisClient.connect).toHaveBeenCalledOnce();
    });

    describe('Publish', () => {
      const message = 'the message';

      test('Should publish message to specified channel', async () => {
        const client = RedisPubSubClient.init();
        const { publish } = await client.makePublisher();

        await publish(message, channel);

        const redisClient = getMockedRedisClient();
        expect(redisClient.publish).toHaveBeenCalledWith(channel, message);
      });

      test('Should error out when the connection is already closed', async () => {
        const client = RedisPubSubClient.init();
        const { publish } = await client.makePublisher();
        const redisClient = getMockedRedisClient();
        redisClient.isOpen = false;

        await expect(publish(message, channel)).rejects.toThrowWithMessage(
          RedisPubSubError,
          'Redis connection is already closed',
        );
      });

      test('Should error out when the connected errored out already', async () => {
        const client = RedisPubSubClient.init();
        const { publish } = await client.makePublisher();
        const redisClient = getMockedRedisClient();
        redisClient.isOpen = false;
        const error = new Error('the error');
        redisClient.emit('error', error);

        const errorWrapped = await getPromiseRejection(publish(message, channel), RedisPubSubError);

        expect(errorWrapped.message).toStartWith('Redis connection closed unexpectedly');
        expect(errorWrapped.cause()).toBe(error);
      });
    });

    describe('Close', () => {
      test('Should quit the Redis connection', async () => {
        const client = RedisPubSubClient.init();
        const { close } = await client.makePublisher();

        await close();

        const redisClient = getMockedRedisClient();
        expect(redisClient.quit).toHaveBeenCalledOnce();
      });

      test('Should do nothing if the connection is already closed', async () => {
        const client = RedisPubSubClient.init();
        const { close } = await client.makePublisher();
        const redisClient = getMockedRedisClient();
        redisClient.isOpen = false;

        await close();

        expect(redisClient.quit).not.toHaveBeenCalled();
      });
    });
  });

  function getMockedRedisClient(): MockRedisClient {
    expect(mockCreateClient).toHaveBeenCalledOnce();
    return mockCreateClient.mock.results[0].value;
  }
});

class MockRedisClient extends EventEmitter {
  readonly connect = jest.fn();
  readonly quit = jest.fn();

  readonly publish = jest.fn();
  readonly subscribe = jest.fn();

  isOpen = true;
}
