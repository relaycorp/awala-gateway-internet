/* tslint:disable:no-let no-console */

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

import { makeNatsPublisher } from './natsStreaming';

const STUB_CLUSTER_ID = 'cluster-id';
const STUB_CLIENT_ID = 'client-id';
const STUB_CHANNEL = 'the-channel';
const STUB_MESSAGE = Buffer.from('the-message');

describe('makeNatsPublisher', () => {
  test('Cluster id should be the specified one', () => {
    makeNatsPublisher(STUB_CLUSTER_ID, STUB_CLIENT_ID, STUB_CHANNEL);

    expect(mockNatsConnect).toBeCalledTimes(1);
    expect(mockNatsConnect).toBeCalledWith(STUB_CLUSTER_ID, expect.anything());
  });

  test('Client id should be the specified one', () => {
    makeNatsPublisher(STUB_CLUSTER_ID, STUB_CLIENT_ID, STUB_CHANNEL);

    expect(mockNatsConnect).toBeCalledTimes(1);
    expect(mockNatsConnect).toBeCalledWith(expect.anything(), STUB_CLIENT_ID);
  });

  describe('Iterable consumer', () => {
    test('Publishing should only be done once the connection has been established', async done => {
      const publisher = makeNatsPublisher(STUB_CLUSTER_ID, STUB_CLIENT_ID, STUB_CHANNEL);

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
      const publisher = makeNatsPublisher(STUB_CLUSTER_ID, STUB_CLIENT_ID, STUB_CHANNEL);

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
      const publisher = makeNatsPublisher(STUB_CLUSTER_ID, STUB_CLIENT_ID, STUB_CHANNEL);

      const error = new Error('Whoops');
      mockConnection.publish.mockImplementation(
        (_channel: any, _data: any, cb: AckHandlerCallback) => cb(error, ''),
      );

      setImmediate(() => mockConnection.emit('connect'));
      await expect(publisher(generateMessages([STUB_MESSAGE, STUB_MESSAGE]))).rejects.toEqual(
        error,
      );

      // Two messages were passed, but publishing should've stopped with the first failure
      expect(mockConnection.publish).toBeCalledTimes(1);
    });

    test('Publishing multiple messages should be supported', async () => {
      const publisher = makeNatsPublisher(STUB_CLUSTER_ID, STUB_CLIENT_ID, STUB_CHANNEL);
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
      const publisher = makeNatsPublisher(STUB_CLUSTER_ID, STUB_CLIENT_ID, STUB_CHANNEL);

      const error = new Error('Whoops');
      mockConnection.publish.mockImplementation(
        (_channel: any, _data: any, cb: AckHandlerCallback) => cb(error, ''),
      );

      setImmediate(() => mockConnection.emit('connect'));
      await expect(publisher(generateMessages([STUB_MESSAGE]))).toReject();

      expect(mockConnection.close).toBeCalled();
    });

    test('Connection should be closed upon successful completion', async () => {
      const publisher = makeNatsPublisher(STUB_CLUSTER_ID, STUB_CLIENT_ID, STUB_CHANNEL);

      setImmediate(() => mockConnection.emit('connect'));
      await publisher(generateMessages([STUB_MESSAGE]));

      expect(mockConnection.close).toBeCalled();
    });
  });
});

function* generateMessages(messages: readonly Buffer[]): IterableIterator<Buffer> {
  for (const message of messages) {
    yield message;
  }
}
