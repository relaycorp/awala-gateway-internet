import * as grpc from '@grpc/grpc-js';
import { CargoRelayService } from '@relaycorp/cogrpc';
import * as grpcHealthCheck from 'grpc-js-health-check';
import { Logger } from 'pino';

import { createMongooseConnectionFromEnv } from '../../backingServices/mongo';
import { MAX_RAMF_MESSAGE_SIZE } from '../../constants';
import { getMockContext, mockSpy } from '../../testUtils/jest';
import { makeMockLogging, partialPinoLog } from '../../testUtils/logging';
import * as exitHandling from '../../utilities/exitHandling';
import * as logging from '../../utilities/logging';
import { runServer } from './server';
import * as cogrpcService from './service';
import { mockQueueEmitter } from '../../testUtils/eventing/mockQueueEmitter';

const makeServiceImplementationSpy = mockSpy(jest.spyOn(cogrpcService, 'makeService'));
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

const mockExitHandler = mockSpy(jest.spyOn(exitHandling, 'configureExitHandling'));

const mockLogger = makeMockLogging().logger;
const mockMakeLogger = mockSpy(jest.spyOn(logging, 'makeLogger'), () => mockLogger);

const queueEmitter = mockQueueEmitter();

describe('runServer', () => {
  test('Exit handler should be configured', async () => {
    await runServer();

    expect(mockExitHandler).toBeCalledWith(mockLogger);
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
    expect(makeServiceImplementationSpy).toBeCalledWith<[cogrpcService.ServiceOptions]>({
      baseLogger: expect.objectContaining<Partial<Logger>>({
        debug: expect.anything(),
        error: expect.anything(),
      }),
      getMongooseConnection: createMongooseConnectionFromEnv,
      queueEmitter,
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
