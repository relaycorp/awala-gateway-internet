import * as grpc from '@grpc/grpc-js';
import { CargoRelayService } from '@relaycorp/cogrpc';
import * as grpcHealthCheck from 'grpc-js-health-check';
import { Logger } from 'pino';
import selfsigned from 'selfsigned';

import { makeMockLogging, mockSpy, partialPinoLog } from '../../_test_utils';
import { createMongooseConnectionFromEnv } from '../../backingServices/mongo';
import { MAX_RAMF_MESSAGE_SIZE } from '../../constants';
import * as exitHandling from '../../utilities/exitHandling';
import * as logging from '../../utilities/logging';
import { configureMockEnvVars, getMockContext } from '../_test_utils';
import { runServer } from './server';
import * as cogrpcService from './service';

const makeServiceImplementationSpy = mockSpy(
  jest.spyOn(cogrpcService, 'makeServiceImplementation'),
);
const mockServer = {
  addService: mockSpy(jest.fn()),
  bindAsync: mockSpy(jest.fn(), (_netloc, _credentials, cb) => cb()),
  start: mockSpy(jest.fn()),
};
jest.mock('@grpc/grpc-js', () => {
  const grpcOriginal = jest.requireActual('@grpc/grpc-js');
  return {
    ...grpcOriginal,
    Server: jest.fn().mockImplementation(() => mockServer),
  };
});

const mockSelfSignedOutput = {
  cert: 'the certificate, PEM-encoded',
  private: 'the private key, PEM-encoded',
};
const mockSelfSigned = mockSpy(jest.spyOn(selfsigned, 'generate'), () => mockSelfSignedOutput);

const mockExitHandler = mockSpy(jest.spyOn(exitHandling, 'configureExitHandling'));

const BASE_ENV_VARS = {
  NATS_CLUSTER_ID: 'nats-cluster-id',
  NATS_SERVER_URL: 'nats://example.com',
  OBJECT_STORE_BUCKET: 'bucket-name',
  PUBLIC_ADDRESS: 'gateway.com',
  SERVER_IP_ADDRESS: '127.0.0.1',
};
const mockEnvVars = configureMockEnvVars(BASE_ENV_VARS);

const mockLogger = makeMockLogging().logger;
const mockMakeLogger = mockSpy(jest.spyOn(logging, 'makeLogger'), () => mockLogger);

describe('runServer', () => {
  test('Exit handler should be configured as the very first step', async () => {
    mockEnvVars({});

    await expect(runServer()).toReject();
    expect(mockExitHandler).toBeCalledWith(mockLogger);
  });

  test.each([
    'NATS_SERVER_URL',
    'NATS_CLUSTER_ID',
    'OBJECT_STORE_BUCKET',
    'PUBLIC_ADDRESS',
    'SERVER_IP_ADDRESS',
  ])('Environment variable %s should be present', async (envVar) => {
    mockEnvVars({ ...BASE_ENV_VARS, [envVar]: undefined });

    await expect(runServer).rejects.toMatchObject(new RegExp(envVar));
  });

  test('Server should accept the largest possible RAMF messages', async () => {
    const expectMaxLength = MAX_RAMF_MESSAGE_SIZE + 256;

    await runServer();

    expect(grpc.Server).toBeCalledWith(
      expect.objectContaining({ 'grpc.max_receive_message_length': expectMaxLength }),
    );
  });

  test('Server should accept metadata of up to 6 kb', async () => {
    await runServer();

    expect(grpc.Server).toBeCalledWith(
      expect.objectContaining({ 'grpc.max_metadata_size': 6_000 }),
    );
  });

  test('Server should accept up to 3 concurrent calls per connection', async () => {
    await runServer();

    expect(grpc.Server).toBeCalledWith(
      expect.objectContaining({ 'grpc.max_concurrent_streams': 3 }),
    );
  });

  test('Server should allow connections to last up to 15 minutes', async () => {
    await runServer();

    expect(grpc.Server).toBeCalledWith(
      expect.objectContaining({ 'grpc.max_connection_age_ms': 15 * 60 * 1_000 }),
    );
  });

  test('Server should allow clients to gracefully end connections in up to 30 seconds', async () => {
    await runServer();

    expect(grpc.Server).toBeCalledWith(
      expect.objectContaining({ 'grpc.max_connection_age_grace_ms': 30_000 }),
    );
  });

  test('Server should allow connections to go idle for up to 5 seconds', async () => {
    await runServer();

    expect(grpc.Server).toBeCalledWith(
      expect.objectContaining({ 'grpc.max_connection_idle_ms': 5_000 }),
    );
  });

  test('CogRPC service should be added', async () => {
    await runServer();

    expect(makeServiceImplementationSpy).toBeCalledTimes(1);
    expect(makeServiceImplementationSpy).toBeCalledWith({
      baseLogger: expect.objectContaining<Partial<Logger>>({
        debug: expect.anything(),
        error: expect.anything(),
      }),
      getMongooseConnection: createMongooseConnectionFromEnv,
      natsClusterId: BASE_ENV_VARS.NATS_CLUSTER_ID,
      natsServerUrl: BASE_ENV_VARS.NATS_SERVER_URL,
      parcelStoreBucket: BASE_ENV_VARS.OBJECT_STORE_BUCKET,
      publicAddress: BASE_ENV_VARS.PUBLIC_ADDRESS,
    });
    const serviceImplementation = makeServiceImplementationSpy.mock.results[0].value;

    expect(mockServer.addService).toBeCalledWith(CargoRelayService, serviceImplementation);
  });

  test('Logger should be configured if custom logger is absent', async () => {
    await runServer();

    expect(mockMakeLogger).toBeCalledWith();
    const logger = getMockContext(mockMakeLogger).results[0].value;
    expect(makeServiceImplementationSpy).toBeCalledWith(
      expect.objectContaining({ baseLogger: logger }),
    );
  });

  test('Health check service should be added', async () => {
    await runServer();

    expect(mockServer.addService).toBeCalledWith(
      grpcHealthCheck.service,
      expect.any(grpcHealthCheck.Implementation),
    );
    expect(mockServer.addService).toBeCalledWith(
      expect.anything(),
      expect.objectContaining({
        statusMap: {
          '': grpcHealthCheck.servingStatus.SERVING,
          'relaynet.cogrpc.CargoRelay': grpcHealthCheck.servingStatus.SERVING,
        },
      }),
    );
  });

  test('Server should listen on 0.0.0.0:8080', async () => {
    await runServer();

    expect(mockServer.bindAsync).toBeCalledTimes(1);
    expect(mockServer.bindAsync).toBeCalledWith(
      '0.0.0.0:8080',
      expect.anything(),
      expect.anything(),
    );
  });

  test('Failing to listen on specified port should result in error', async () => {
    const bindError = new Error('Port is apparently taken');
    mockServer.bindAsync.mockImplementation((_netloc, _credentials, cb) => cb(bindError));

    await expect(() => runServer()).rejects.toBe(bindError);
  });

  test('Server should use TLS with a self-issued certificate', async () => {
    const spiedCreateSsl = jest.spyOn(grpc.ServerCredentials, 'createSsl');

    await runServer();

    expect(mockServer.bindAsync).toBeCalledTimes(1);
    expect(spiedCreateSsl).toBeCalledWith(null, [
      {
        cert_chain: Buffer.from(mockSelfSignedOutput.cert),
        private_key: Buffer.from(mockSelfSignedOutput.private),
      },
    ]);
    expect(mockSelfSigned).toBeCalledWith(
      [{ name: 'commonName', value: BASE_ENV_VARS.SERVER_IP_ADDRESS }],
      {
        days: 365,
        extensions: [
          {
            altNames: [{ ip: BASE_ENV_VARS.SERVER_IP_ADDRESS, type: 7 }],
            name: 'subjectAltName',
          },
        ],
      },
    );
  });

  test('gRPC server should be started as the last step', async () => {
    await runServer();

    expect(mockServer.start).toBeCalledTimes(1);
    expect(mockServer.start).toBeCalledWith();
    expect(mockServer.start).toHaveBeenCalledAfter(mockServer.bindAsync as jest.Mock);
  });

  test('A log should be produced when the server is ready', async () => {
    const mockLogging = makeMockLogging();

    await runServer(mockLogging.logger);

    expect(mockLogging.logs).toContainEqual(partialPinoLog('info', 'Ready to receive requests'));
  });
});
