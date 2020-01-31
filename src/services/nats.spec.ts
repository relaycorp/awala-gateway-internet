import { EventEmitter } from 'events';
import * as nats from 'ts-nats';
import { mockEnvVars, restoreEnvVars } from './_test_utils';
import { natsConnect, publishMessage } from './nats';
import { EnvVarError } from 'env-var';

class StubNatsClient extends EventEmitter {
  public readonly publish = jest.fn();
  public readonly flush = jest.fn();
  public readonly close = jest.fn();

  constructor() {
    super();
  }
}

let stubNatsClient: StubNatsClient;
const mockNatsConnect = jest.spyOn(nats, 'connect');
beforeEach(() => {
  stubNatsClient = new StubNatsClient();

  mockNatsConnect.mockReset();
  // @ts-ignore
  mockNatsConnect.mockResolvedValueOnce(stubNatsClient);
});

afterAll(() => {
  mockNatsConnect.mockRestore();
  restoreEnvVars();
});

const stubSubject = 'the.topic.looks.like.this';
const stubPayload = Buffer.from('the payload');

const stubNatsServerUrl = 'nats://example.com:4222';
beforeEach(() => {
  mockEnvVars({ NATS_SERVERS: stubNatsServerUrl });
});

describe('natsConnect', () => {
  test('Env var NATS_SERVERS must be set', async () => {
    mockEnvVars({});

    await expect(natsConnect()).rejects.toBeInstanceOf(EnvVarError);
  });

  test('Client should connect to specified server', async () => {
    await natsConnect();

    expect(mockNatsConnect.mock.calls[0][0]).toHaveProperty('servers', [stubNatsServerUrl]);
  });

  test('Connecting to multiple servers should be supported', async () => {
    const additionalServer = 'tls://acme.com';
    mockEnvVars({ NATS_SERVERS: `${stubNatsServerUrl} ${additionalServer}` });

    await natsConnect();

    expect(mockNatsConnect.mock.calls[0][0]).toHaveProperty('servers', [
      stubNatsServerUrl,
      additionalServer,
    ]);
  });

  test('NATS client should be returned when connection succeeds', async () => {
    const client = await natsConnect();

    expect(client).toBe(stubNatsClient);
  });

  test('Authentication should be skipped if env var NATS_TOKEN is absent', async () => {
    await natsConnect();

    expect(mockNatsConnect.mock.calls[0][0]).toHaveProperty('token', undefined);
  });

  test('Authentication token should be used if env var NATS_TOKEN is present', async () => {
    const natsToken = 'letmein';
    mockEnvVars({ NATS_SERVERS: stubNatsServerUrl, NATS_TOKEN: natsToken });

    await natsConnect();

    expect(mockNatsConnect.mock.calls[0][0]).toHaveProperty('token', natsToken);
  });

  test('Payloads should be binary', async () => {
    await natsConnect();

    expect(mockNatsConnect.mock.calls[0][0]).toHaveProperty('payload', nats.Payload.BINARY);
  });
});

describe('publishMessage', () => {
  test('Message should be published to the specified subject', async () => {
    await publishMessage(stubSubject, stubPayload);

    expect(stubNatsClient.publish).toBeCalledTimes(1);
    expect(stubNatsClient.publish).toBeCalledWith(stubSubject, stubPayload);

    expect(stubNatsClient.flush).toBeCalledTimes(1);
    expect(stubNatsClient.close).toBeCalledTimes(1);
    expect(stubNatsClient.close).toHaveBeenCalledAfter(stubNatsClient.flush);
  });

  test('"error" event should be thrown', async () => {
    const error = new Error('Could not connect');
    stubNatsClient.publish.mockImplementation(() => {
      stubNatsClient.emit('error', error);
    });

    await expect(publishMessage(stubSubject, stubPayload)).rejects.toEqual(error);

    expect(stubNatsClient.flush).toBeCalledTimes(1);
    expect(stubNatsClient.close).toBeCalledTimes(1);
    expect(stubNatsClient.close).toHaveBeenCalledAfter(stubNatsClient.flush);
  });

  test('"permissionError" event should be thrown', async () => {
    const error = new Error('Denied');
    stubNatsClient.publish.mockImplementation(() => {
      stubNatsClient.emit('permissionError', error);
    });

    await expect(publishMessage(stubSubject, stubPayload)).rejects.toEqual(error);

    expect(stubNatsClient.flush).toBeCalledTimes(1);
    expect(stubNatsClient.close).toBeCalledTimes(1);
    expect(stubNatsClient.close).toHaveBeenCalledAfter(stubNatsClient.flush);
  });
});
