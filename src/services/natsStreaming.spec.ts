/* tslint:disable:no-let max-classes-per-file */

import { EventEmitter } from 'events';
import { AckHandlerCallback, SubscriptionOptions } from 'node-nats-streaming';

class MockNatsSubscription extends EventEmitter {
  public readonly unsubscribe = jest.fn();
}

class MockNatsConnection extends EventEmitter {
  public readonly close = jest.fn();

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
  const stubClient = new NatsStreamingClient(STUB_SERVER_URL, STUB_CLUSTER_ID, STUB_CLIENT_ID);

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
        expect(mockConnection.on).toBeCalledTimes(1);
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

    test('Publishing multiple messages from an iterator should be supported', async () => {
      const publisher = stubClient.makePublisher(STUB_CHANNEL);
      setImmediate(() => mockConnection.emit('connect'));

      await asyncIterableToArray(publisher(arrayToIterator([STUB_MESSAGE_1, STUB_MESSAGE_2])));

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

    test('Connection should be closed upon failure', async () => {
      const publisher = stubClient.makePublisher(STUB_CHANNEL);

      const error = new Error('Whoops');
      mockConnection.publish.mockImplementation(
        (_channel: any, _data: any, cb: AckHandlerCallback) => cb(error, ''),
      );
      setImmediate(() => mockConnection.emit('connect'));

      await expect(asyncIterableToArray(publisher([STUB_MESSAGE_1]))).toReject();

      expect(mockConnection.close).toBeCalled();
    });

    test('Connection should be closed upon successful completion', async () => {
      const publisher = stubClient.makePublisher(STUB_CHANNEL);
      setImmediate(() => mockConnection.emit('connect'));

      await asyncIterableToArray(publisher([STUB_MESSAGE_1]));

      expect(mockConnection.close).toBeCalled();
    });

    test('Consumer should not be called multiple times', async () => {
      const publisher = stubClient.makePublisher(STUB_CHANNEL);
      setImmediate(() => mockConnection.emit('connect'));

      await asyncIterableToArray(publisher([STUB_MESSAGE_1]));

      // @ts-ignore
      mockConnection.on.mockClear();

      await expect(asyncIterableToArray(publisher([]))).rejects.toMatchObject<Partial<Error>>({
        message: 'Publisher cannot be reused as the connection was already closed',
      });

      expect(mockConnection.on).not.toBeCalled();
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

    describe('Connection', () => {
      test('Server URL should be the specified one', async () => {
        const consumer = stubClient.makeQueueConsumer(STUB_CHANNEL, STUB_QUEUE, STUB_DURABLE_NAME);
        fakeConnectionThenUnsubscribe();

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
        fakeConnectionThenUnsubscribe();

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
        fakeConnectionThenUnsubscribe();

        await asyncIterableToArray(consumer);

        expect(mockNatsConnect).toBeCalledTimes(1);
        expect(mockNatsConnect).toBeCalledWith(
          expect.anything(),
          STUB_CLIENT_ID,
          expect.anything(),
        );
      });
    });

    describe('Subscription', () => {
      test('Subscription should start once the connection has been established', async done => {
        const publisher = stubClient.makePublisher(STUB_CHANNEL);
        setImmediate(() => {
          // "connect" event was never emitted, so no message should've been published
          expect(mockConnection.on).toBeCalledTimes(1);
          expect(mockConnection.on).toBeCalledWith('connect', expect.any(Function));

          expect(mockConnection.subscribe).not.toBeCalled();

          done();
        });

        await publisher([STUB_MESSAGE_1]);
      });

      test('Channel should be the specified one', async () => {
        const consumer = stubClient.makeQueueConsumer(STUB_CHANNEL, STUB_QUEUE, STUB_DURABLE_NAME);
        fakeConnectionThenUnsubscribe();

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
        fakeConnectionThenUnsubscribe();

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
          fakeConnectionThenUnsubscribe();

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
      setImmediate(() => {
        mockSubscription.emit('unsubscribed');
      });

      await expect(asyncIterableToArray(consumer)).resolves.toEqual([stubMessage1, stubMessage2]);
    });

    test('Connection and subscription should be closed after a subscription error', async () => {
      const consumer = stubClient.makeQueueConsumer(STUB_CHANNEL, STUB_QUEUE, STUB_DURABLE_NAME);
      const error = new Error('Whoops, my bad');
      setImmediate(() => {
        mockConnection.emit('connect');
      });
      setImmediate(() => {
        mockSubscription.emit('error', error);
      });

      await expect(asyncIterableToArray(consumer)).rejects.toEqual(error);

      expect(mockSubscription.unsubscribe).toBeCalledTimes(1);
      expect(mockConnection.close).toBeCalledTimes(1);
    });

    test('Connection and subscription should be closed after consuming messages', async () => {
      const consumer = stubClient.makeQueueConsumer(STUB_CHANNEL, STUB_QUEUE, STUB_DURABLE_NAME);
      fakeConnectionThenUnsubscribe();

      await asyncIterableToArray(consumer);

      expect(mockSubscription.unsubscribe).toBeCalledTimes(1);
      expect(mockConnection.close).toBeCalledTimes(1);
    });

    function fakeConnectionThenUnsubscribe(): void {
      setImmediate(() => mockConnection.emit('connect'));
      setImmediate(() => mockSubscription.emit('unsubscribed'));
    }
  });
});

function* arrayToIterator<T>(array: readonly T[]): IterableIterator<T> {
  for (const item of array) {
    yield item;
  }
}

async function asyncIterableToArray<T>(iterable: AsyncIterable<T>): Promise<readonly T[]> {
  // tslint:disable-next-line:readonly-array
  const values = [];
  for await (const item of iterable) {
    values.push(item);
  }
  return values;
}
