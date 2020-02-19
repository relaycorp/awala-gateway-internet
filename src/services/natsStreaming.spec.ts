/* tslint:disable:no-let */

import { EventEmitter } from 'events';
import { AckHandlerCallback } from 'node-nats-streaming';

class MockNatsConnection extends EventEmitter {
  public readonly close = jest.fn();

  public readonly publish = jest
    .fn()
    .mockImplementation((_channel: string, _data: Buffer, cb: AckHandlerCallback) =>
      cb(undefined, 'stub-guid'),
    );
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

import { NatsStreamingClient } from './natsStreaming';

const STUB_SERVER_URL = 'nats://example.com';
const STUB_CLUSTER_ID = 'cluster-id';
const STUB_CLIENT_ID = 'client-id';
const STUB_CHANNEL = 'the-channel';
const STUB_MESSAGE = Buffer.from('the-message');

describe('NatsStreamingClient', () => {
  const client = new NatsStreamingClient(STUB_SERVER_URL, STUB_CLUSTER_ID, STUB_CLIENT_ID);

  describe('makePublisher', () => {
    test('Server URL should be the specified one', async () => {
      const publisher = client.makePublisher(STUB_CHANNEL);
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
      const publisher = client.makePublisher(STUB_CHANNEL);
      setImmediate(() => mockConnection.emit('connect'));

      await publisher([]);

      expect(mockNatsConnect).toBeCalledTimes(1);
      expect(mockNatsConnect).toBeCalledWith(STUB_CLUSTER_ID, expect.anything(), expect.anything());
    });

    test('Client id should be the specified one', async () => {
      const publisher = client.makePublisher(STUB_CHANNEL);
      setImmediate(() => mockConnection.emit('connect'));

      await publisher([]);

      expect(mockNatsConnect).toBeCalledTimes(1);
      expect(mockNatsConnect).toBeCalledWith(expect.anything(), STUB_CLIENT_ID, expect.anything());
    });

    test('Publishing should only be done once the connection has been established', async done => {
      const publisher = client.makePublisher(STUB_CHANNEL);
      setImmediate(() => {
        // "connect" event was never emitted, so no message should've been published
        expect(mockConnection.on).toBeCalledTimes(1);
        expect(mockConnection.on).toBeCalledWith('connect', expect.any(Function));

        expect(mockConnection.publish).not.toBeCalled();

        done();
      });

      await publisher(generateMessages([STUB_MESSAGE]));
    });

    test('Messages should be published to the specified channel', async () => {
      const publisher = client.makePublisher(STUB_CHANNEL);
      setImmediate(() => mockConnection.emit('connect'));

      await publisher(generateMessages([STUB_MESSAGE]));

      expect(mockConnection.publish).toBeCalledTimes(1);
      expect(mockConnection.publish).toBeCalledWith(
        STUB_CHANNEL,
        STUB_MESSAGE,
        expect.any(Function),
      );
    });

    test('Iteration should be aborted if a message fails to be published', async () => {
      const publisher = client.makePublisher(STUB_CHANNEL);
      setImmediate(() => mockConnection.emit('connect'));

      const error = new Error('Whoops');
      mockConnection.publish.mockImplementation(
        (_channel: any, _data: any, cb: AckHandlerCallback) => cb(error, ''),
      );

      await expect(publisher(generateMessages([STUB_MESSAGE, STUB_MESSAGE]))).rejects.toEqual(
        error,
      );

      // Two messages were passed, but publishing should've stopped with the first failure
      expect(mockConnection.publish).toBeCalledTimes(1);
    });

    test('Publishing multiple messages from an array should be supported', async () => {
      const publisher = client.makePublisher(STUB_CHANNEL);
      const additionalStubMessage = Buffer.from('additional message here');
      setImmediate(() => mockConnection.emit('connect'));

      await publisher([STUB_MESSAGE, additionalStubMessage]);

      expect(mockConnection.publish).toBeCalledTimes(2);
      expect(mockConnection.publish).toBeCalledWith(
        expect.anything(),
        STUB_MESSAGE,
        expect.anything(),
      );
      expect(mockConnection.publish).toBeCalledWith(
        expect.anything(),
        additionalStubMessage,
        expect.anything(),
      );
    });

    test('Publishing multiple messages from an iterator should be supported', async () => {
      const publisher = client.makePublisher(STUB_CHANNEL);
      const additionalStubMessage = Buffer.from('additional message here');
      setImmediate(() => mockConnection.emit('connect'));

      await publisher(generateMessages([STUB_MESSAGE, additionalStubMessage]));

      expect(mockConnection.publish).toBeCalledTimes(2);
      expect(mockConnection.publish).toBeCalledWith(
        expect.anything(),
        STUB_MESSAGE,
        expect.anything(),
      );
      expect(mockConnection.publish).toBeCalledWith(
        expect.anything(),
        additionalStubMessage,
        expect.anything(),
      );
    });

    test('Connection should be closed upon failure', async () => {
      const publisher = client.makePublisher(STUB_CHANNEL);

      const error = new Error('Whoops');
      mockConnection.publish.mockImplementation(
        (_channel: any, _data: any, cb: AckHandlerCallback) => cb(error, ''),
      );
      setImmediate(() => mockConnection.emit('connect'));

      await expect(publisher(generateMessages([STUB_MESSAGE]))).toReject();

      expect(mockConnection.close).toBeCalled();
    });

    test('Connection should be closed upon successful completion', async () => {
      const publisher = client.makePublisher(STUB_CHANNEL);
      setImmediate(() => mockConnection.emit('connect'));

      await publisher(generateMessages([STUB_MESSAGE]));

      expect(mockConnection.close).toBeCalled();
    });

    test('Consumer should be called multiple times', async () => {
      const publisher = client.makePublisher(STUB_CHANNEL);
      setImmediate(() => mockConnection.emit('connect'));

      await publisher(generateMessages([STUB_MESSAGE]));

      // @ts-ignore
      mockConnection.on.mockClear();

      await expect(publisher(generateMessages([]))).rejects.toMatchObject<Partial<Error>>({
        message: 'Publisher cannot be reused as the connection was already closed',
      });

      expect(mockConnection.on).not.toBeCalled();
    });
  });
});

function* generateMessages(messages: readonly Buffer[]): IterableIterator<Buffer> {
  for (const message of messages) {
    yield message;
  }
}
