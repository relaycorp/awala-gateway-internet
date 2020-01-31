import * as nats from 'ts-nats';
import { mockEnvVars, restoreEnvVars } from './_test_utils';
import { natsConnect } from './nats';
import { EnvVarError } from 'env-var';

const stubNatsClient = { foo: 'bar' };
const mockNatsConnect = jest.spyOn(nats, 'connect');
beforeEach(() => {
  mockNatsConnect.mockReset();
  // @ts-ignore
  mockNatsConnect.mockResolvedValueOnce(stubNatsClient);
});

afterAll(() => {
  mockNatsConnect.mockRestore();
  restoreEnvVars();
});

describe('natsConnect', () => {
  const stubNatsServerUrl = 'nats://example.com:4222';

  beforeEach(() => {
    mockEnvVars({ NATS_SERVERS: stubNatsServerUrl });
  });

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
});
