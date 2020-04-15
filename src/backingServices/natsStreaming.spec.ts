/* tslint:disable:no-let max-classes-per-file */

import { EventEmitter } from 'events';
import { AckHandlerCallback, SubscriptionOptions } from 'node-nats-streaming';

import { arrayToAsyncIterable, asyncIterableToArray, mockSpy } from '../_test_utils';

class MockNatsSubscription extends EventEmitter {
  public readonly close = jest.fn();
}

class MockNatsConnection extends EventEmitter {
  public readonly close = jest.fn().mockImplementation(function(this: MockNatsConnection): void {
    this.emit('close');
  });

  public readonly publish = jest
    .fn()
    .mockImplementation((_channel: string, _data: Buffer, cb: AckHandlerCallback) =>
      cb(undefined, 'stub-guid'),
    );

  public readonly subscribe = jest.fn();

  public readonly subscriptionOptions = jest.fn();
}

let mockConnection: MockNatsConnection;
const mockNatsConnect = jest.fn();
beforeEach(() => {
  mockConnection = new MockNatsConnection();
  jest.spyOn(mockConnection, 'on');

  mockNatsConnect.mockReset();
  mockNatsConnect.mockImplementation(() => mockConnection);
});
jest.mock('node-nats-streaming', () => {
  return {
    connect: mockNatsConnect,
  };
});
import { NatsStreamingClient, PublisherMessage } from './natsStreaming';

const STUB_SERVER_URL = 'nats://example.com';
const STUB_CLUSTER_ID = 'cluster-id';
const STUB_CLIENT_ID = 'client-id';
const STUB_CHANNEL = 'the-channel';
const STUB_MESSAGE_1: PublisherMessage = {
  data: Buffer.from('the-message'),
  id: 'stub-message-id',
};
const STUB_MESSAGE_2: PublisherMessage = {
  data: Buffer.from('additional message here'),
  id: 'additional-id',
};

describe('NatsStreamingClient', () => {
  let stubClient: NatsStreamingClient;
  beforeEach(() => {
    stubClient = new NatsStreamingClient(STUB_SERVER_URL, STUB_CLUSTER_ID, STUB_CLIENT_ID);
  });

  describe('makePublisher', () => {
    test('Server URL should be the specified one', async () => {
      const publisher = stubClient.makePublisher(STUB_CHANNEL);
      setImmediate(() => mockConnection.emit('connect'));

      await publisher([]);

      expect(mockNatsConnect).toBeCalledTimes(1);
      expect(mockNatsConnect).toBeCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ url: STUB_SERVER_URL }),
      );
    });

    test('Cluster id should be the specified one', async () => {
      const publisher = stubClient.makePublisher(STUB_CHANNEL);
      setImmediate(() => mockConnection.emit('connect'));

      await publisher([]);

      expect(mockNatsConnect).toBeCalledTimes(1);
      expect(mockNatsConnect).toBeCalledWith(STUB_CLUSTER_ID, expect.anything(), expect.anything());
    });

    test('Client id should be the specified one', async () => {
      const publisher = stubClient.makePublisher(STUB_CHANNEL);
      setImmediate(() => mockConnection.emit('connect'));

      await publisher([]);

      expect(mockNatsConnect).toBeCalledTimes(1);
      expect(mockNatsConnect).toBeCalledWith(expect.anything(), STUB_CLIENT_ID, expect.anything());
    });

    test('Publishing should only be done once the connection has been established', async done => {
      const publisher = stubClient.makePublisher(STUB_CHANNEL);
      setImmediate(() => {
        // "connect" event was never emitted, so no message should've been published
        expect(mockConnection.on).toBeCalledWith('connect', expect.any(Function));

        expect(mockConnection.publish).not.toBeCalled();

        done();
      });

      await publisher([STUB_MESSAGE_1]);
    });

    test('Messages should be published to the specified channel', async () => {
      const publisher = stubClient.makePublisher(STUB_CHANNEL);
      setImmediate(() => mockConnection.emit('connect'));

      await asyncIterableToArray(publisher([STUB_MESSAGE_1]));

      expect(mockConnection.publish).toBeCalledTimes(1);
      expect(mockConnection.publish).toBeCalledWith(
        STUB_CHANNEL,
        STUB_MESSAGE_1.data,
        expect.any(Function),
      );
    });

    test('Iteration should be aborted if a message fails to be published', async () => {
      const publisher = stubClient.makePublisher(STUB_CHANNEL);
      setImmediate(() => mockConnection.emit('connect'));

      const error = new Error('Whoops');
      mockConnection.publish.mockImplementation(
        (_channel: any, _data: any, cb: AckHandlerCallback) => cb(error, ''),
      );

      await expect(
        asyncIterableToArray(publisher([STUB_MESSAGE_1, STUB_MESSAGE_2])),
      ).rejects.toEqual(error);

      // Two messages were passed, but publishing should've stopped with the first failure
      expect(mockConnection.publish).toBeCalledTimes(1);
    });

    test('Publishing multiple messages from an array should be supported', async () => {
      const publisher = stubClient.makePublisher(STUB_CHANNEL);
      setImmediate(() => mockConnection.emit('connect'));

      await asyncIterableToArray(publisher([STUB_MESSAGE_1, STUB_MESSAGE_2]));

      expect(mockConnection.publish).toBeCalledTimes(2);
      expect(mockConnection.publish).toBeCalledWith(
        expect.anything(),
        STUB_MESSAGE_1.data,
        expect.anything(),
      );
      expect(mockConnection.publish).toBeCalledWith(
        expect.anything(),
        STUB_MESSAGE_2.data,
        expect.anything(),
      );
    });

    test('Ids of published message should be yielded', async () => {
      const publisher = stubClient.makePublisher(STUB_CHANNEL);
      setImmediate(() => mockConnection.emit('connect'));

      const publishedIds = await publisher([STUB_MESSAGE_1, STUB_MESSAGE_2]);

      await expect(asyncIterableToArray(publishedIds)).resolves.toEqual([
        STUB_MESSAGE_1.id,
        STUB_MESSAGE_2.id,
      ]);
    });

    test('Publishing multiple messages from an async iterable should be supported', async () => {
      const publisher = stubClient.makePublisher(STUB_CHANNEL);
      setImmediate(() => mockConnection.emit('connect'));

      await asyncIterableToArray(publisher(arrayToAsyncIterable([STUB_MESSAGE_1, STUB_MESSAGE_2])));

      expect(mockConnection.publish).toBeCalledTimes(2);
      expect(mockConnection.publish).toBeCalledWith(
        expect.anything(),
        STUB_MESSAGE_1.data,
        expect.anything(),
      );
      expect(mockConnection.publish).toBeCalledWith(
        expect.anything(),
        STUB_MESSAGE_2.data,
        expect.anything(),
      );
    });

    test('Previous connection should be reused if active', async () => {
      const publisher1 = stubClient.makePublisher(STUB_CHANNEL);
      setImmediate(() => mockConnection.emit('connect'));
      await asyncIterableToArray(publisher1([STUB_MESSAGE_1]));

      const publisher2 = stubClient.makePublisher(STUB_CHANNEL);
      setImmediate(() => mockConnection.emit('connect'));
      await asyncIterableToArray(publisher2([STUB_MESSAGE_1]));

      expect(mockNatsConnect).toBeCalledTimes(1);
    });
  });

  test('publishMessage() should send a single message via a dedicated connection', async () => {
    const client = new NatsStreamingClient(STUB_SERVER_URL, STUB_CLUSTER_ID, STUB_CLIENT_ID);
    jest.spyOn(client, 'makePublisher');
    setImmediate(() => mockConnection.emit('connect'));

    await client.publishMessage(STUB_MESSAGE_1.data, STUB_CHANNEL);

    expect(client.makePublisher).toBeCalledWith(STUB_CHANNEL);
    expect(mockConnection.publish).toBeCalledWith(
      STUB_CHANNEL,
      STUB_MESSAGE_1.data,
      expect.any(Function),
    );
  });

  describe('makeQueueConsumer', () => {
    const STUB_QUEUE = 'queue-name';
    const STUB_DURABLE_NAME = 'durable-name';

    let mockSubscription: MockNatsSubscription;
    let mockSubscriptionOptions: Partial<SubscriptionOptions>;
    beforeEach(() => {
      mockSubscriptionOptions = {
        setAckWait: jest.fn().mockReturnThis(),
        setDeliverAllAvailable: jest.fn().mockReturnThis(),
        setDurableName: jest.fn().mockReturnThis(),
        setManualAckMode: jest.fn().mockReturnThis(),
        setMaxInFlight: jest.fn().mockReturnThis(),
      };

      mockSubscription = new MockNatsSubscription();
      mockConnection.subscribe.mockImplementation(() => mockSubscription);
      mockConnection.subscriptionOptions.mockReturnValue(mockSubscriptionOptions);
    });

    const mockProcessExit = mockSpy(jest.spyOn(process, 'exit'), () => undefined);

    describe('Connection', () => {
      test('Server URL should be the specified one', async () => {
        const consumer = stubClient.makeQueueConsumer(STUB_CHANNEL, STUB_QUEUE, STUB_DURABLE_NAME);
        fakeConnectionThenInterrupt();

        await asyncIterableToArray(consumer);

        expect(mockNatsConnect).toBeCalledTimes(1);
        expect(mockNatsConnect).toBeCalledWith(
          expect.anything(),
          expect.anything(),
          expect.objectContaining({ url: STUB_SERVER_URL }),
        );
      });

      test('Cluster id should be the specified one', async () => {
        const consumer = stubClient.makeQueueConsumer(STUB_CHANNEL, STUB_QUEUE, STUB_DURABLE_NAME);
        fakeConnectionThenInterrupt();

        await asyncIterableToArray(consumer);

        expect(mockNatsConnect).toBeCalledTimes(1);
        expect(mockNatsConnect).toBeCalledWith(
          STUB_CLUSTER_ID,
          expect.anything(),
          expect.anything(),
        );
      });

      test('Client id should be the specified one', async () => {
        const consumer = stubClient.makeQueueConsumer(STUB_CHANNEL, STUB_QUEUE, STUB_DURABLE_NAME);
        fakeConnectionThenInterrupt();

        await asyncIterableToArray(consumer);

        expect(mockNatsConnect).toBeCalledTimes(1);
        expect(mockNatsConnect).toBeCalledWith(
          expect.anything(),
          STUB_CLIENT_ID,
          expect.anything(),
        );
      });
    });

    describe('Subscription creation', () => {
      test('Subscription should start once the connection has been established', async done => {
        const consumer = stubClient.makeQueueConsumer(STUB_CHANNEL, STUB_QUEUE, STUB_DURABLE_NAME);
        setImmediate(() => {
          // "connect" event was never emitted, so no message should've been published
          expect(mockConnection.on).toBeCalledWith('connect', expect.any(Function));

          expect(mockConnection.subscribe).not.toBeCalled();

          done();
        });

        await asyncIterableToArray(consumer);
      });

      test('Channel should be the specified one', async () => {
        const consumer = stubClient.makeQueueConsumer(STUB_CHANNEL, STUB_QUEUE, STUB_DURABLE_NAME);
        fakeConnectionThenInterrupt();

        await asyncIterableToArray(consumer);

        expect(mockConnection.subscribe).toBeCalledTimes(1);
        expect(mockConnection.subscribe).toBeCalledWith(
          STUB_CHANNEL,
          expect.anything(),
          expect.anything(),
        );
      });

      test('Queue should be the specified one', async () => {
        const consumer = stubClient.makeQueueConsumer(STUB_CHANNEL, STUB_QUEUE, STUB_DURABLE_NAME);
        fakeConnectionThenInterrupt();

        await asyncIterableToArray(consumer);

        expect(mockConnection.subscribe).toBeCalledTimes(1);
        expect(mockConnection.subscribe).toBeCalledWith(
          expect.anything(),
          STUB_QUEUE,
          expect.anything(),
        );
      });

      test.each([
        ['setDurableName', [STUB_DURABLE_NAME]],
        ['setDeliverAllAvailable', []],
        ['setManualAckMode', [true]],
        ['setAckWait', [5_000]],
        ['setMaxInFlight', [1]],
      ] as ReadonlyArray<readonly [keyof SubscriptionOptions, readonly any[]]>)(
        'Option %s should be %s',
        async (optKey, optArgs) => {
          const consumer = stubClient.makeQueueConsumer(
            STUB_CHANNEL,
            STUB_QUEUE,
            STUB_DURABLE_NAME,
          );
          fakeConnectionThenInterrupt();

          await asyncIterableToArray(consumer);

          expect(mockConnection.subscribe).toBeCalledTimes(1);
          expect(mockConnection.subscribe).toBeCalledWith(
            expect.anything(),
            expect.anything(),
            mockSubscriptionOptions,
          );
          expect(mockSubscriptionOptions[optKey]).toBeCalledWith(...optArgs);
        },
      );

      test('Errors thrown while establishing subscription should be propagated', async () => {
        const error = new Error('Nope');
        mockConnection.subscribe.mockImplementationOnce(() => {
          throw error;
        });
        const consumer = stubClient.makeQueueConsumer(STUB_CHANNEL, STUB_QUEUE, STUB_DURABLE_NAME);
        fakeConnectionThenInterrupt();

        await expect(asyncIterableToArray(consumer)).rejects.toEqual(error);
      });
    });

    test('Incoming messages should be yielded until subscription ends', async () => {
      const consumer = stubClient.makeQueueConsumer(STUB_CHANNEL, STUB_QUEUE, STUB_DURABLE_NAME);
      const stubMessage1 = { number: 1 };
      const stubMessage2 = { number: 2 };
      setImmediate(() => {
        mockConnection.emit('connect');
      });
      setImmediate(() => {
        mockSubscription.emit('message', stubMessage1);
        mockSubscription.emit('message', stubMessage2);
      });
      setImmediate(interruptCurrentProcess);

      await expect(asyncIterableToArray(consumer)).resolves.toEqual([stubMessage1, stubMessage2]);
    });

    test('Subscription should be closed after a subscription error', async () => {
      const consumer = stubClient.makeQueueConsumer(STUB_CHANNEL, STUB_QUEUE, STUB_DURABLE_NAME);
      const error = new Error('Whoops, my bad');
      setImmediate(() => {
        mockConnection.emit('connect');
      });
      setImmediate(() => {
        mockSubscription.emit('error', error);
      });

      await expect(asyncIterableToArray(consumer)).rejects.toEqual(error);

      expect(mockSubscription.close).toBeCalledTimes(1);
    });

    test.each(['SIGINT', 'SIGTERM'])(
      '%s should close the subscription and end the process',
      async signal => {
        const consumer = stubClient.makeQueueConsumer(STUB_CHANNEL, STUB_QUEUE, STUB_DURABLE_NAME);
        setImmediate(() => mockConnection.emit('connect'));
        setImmediate(() => {
          // @ts-ignore
          process.emit(signal);
        });

        await asyncIterableToArray(consumer);

        expect(mockSubscription.close).toBeCalledTimes(1);

        expect(mockProcessExit).toBeCalledTimes(1);
        expect(mockProcessExit).toBeCalledWith(0);
      },
    );

    function fakeConnectionThenInterrupt(): void {
      setImmediate(() => mockConnection.emit('connect'));
      setImmediate(interruptCurrentProcess);
    }

    function interruptCurrentProcess(): void {
      // @ts-ignore
      process.emit('SIGINT');
    }
  });

  describe('disconnect', () => {
    test('Disconnecting before connecting should be a no-op', () => {
      stubClient.disconnect();
    });

    test('Connection should be closed when disconnecting', async () => {
      const publisher = stubClient.makePublisher(STUB_CHANNEL);
      setImmediate(() => mockConnection.emit('connect'));
      await asyncIterableToArray(publisher([STUB_MESSAGE_1]));

      expect(mockConnection.close).not.toBeCalled();
      stubClient.disconnect();

      expect(mockConnection.close).toBeCalledTimes(1);
    });

    test('New connection should be created if previous one cannot be reused', async () => {
      const publisher1 = stubClient.makePublisher(STUB_CHANNEL);
      setImmediate(() => mockConnection.emit('connect'));
      await asyncIterableToArray(publisher1([STUB_MESSAGE_1]));

      stubClient.disconnect();

      const publisher2 = stubClient.makePublisher(STUB_CHANNEL);
      setImmediate(() => mockConnection.emit('connect'));
      await asyncIterableToArray(publisher2([STUB_MESSAGE_1]));

      expect(mockNatsConnect).toBeCalledTimes(2);
    });
  });
});
