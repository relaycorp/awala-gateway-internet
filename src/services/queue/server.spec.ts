import { CloudEvent } from 'cloudevents';

import { makeMockLogging, partialPinoLog } from '../../testUtils/logging';
import { configureMockEnvVars } from '../../testUtils/envVars';
import { mockSpy } from '../../testUtils/jest';
import { HTTP_STATUS_CODES } from '../../utilities/http';
import { CE_SOURCE } from '../../testUtils/eventing/stubs';
import { testDisallowedMethods } from '../../testUtils/fastify';
import { mockRedisPubSubClient } from '../../testUtils/redis';

const CE_TYPE = 'com.example.test.event.type';

const mockHandler = mockSpy(jest.fn());
jest.mock('./sinks/pdcOutgoing', () => ({
  __esModule: true,
  default: { eventType: CE_TYPE, handler: mockHandler },
}));
jest.mock('../../utilities/exitHandling');
jest.mock('../../node/InternetGatewayManager');
jest.mock('../../parcelStore');
import { makeMockQueueServer, makeQueueEventPoster, QUEUE_ENV_VARS } from './_test_utils';
import makeQueueServer from './server';

describe('makeQueueServer', () => {
  configureMockEnvVars(QUEUE_ENV_VARS);
  const redisPubSubClient = mockRedisPubSubClient();

  describe('Disallowed methods', () => {
    testDisallowedMethods(['GET', 'HEAD', 'POST'], '/', makeQueueServer);
  });

  describe('Health checks', () => {
    test('A plain simple HEAD request should provide some diagnostic information', async () => {
      const server = await makeQueueServer();

      const response = await server.inject({ method: 'HEAD', url: '/' });
      await server.close();

      expect(response).toHaveProperty('statusCode', 200);
      expect(response).toHaveProperty('headers.content-type', 'text/plain');
    });

    test('A plain simple GET request should provide some diagnostic information', async () => {
      const server = await makeQueueServer();

      const response = await server.inject({ method: 'GET', url: '/' });
      await server.close();

      expect(response).toHaveProperty('statusCode', 200);
      expect(response).toHaveProperty('headers.content-type', 'text/plain');
      expect(response.payload).toContain('Success');
    });
  });

  test('Explicit logger should be honoured', async () => {
    const { logger, logs } = makeMockLogging();

    const server = await makeQueueServer(logger);
    await server.close();

    const logMessage = 'foo';
    server.log.info(logMessage);
    expect(logs).toContainEqual(partialPinoLog('info', logMessage));
  });

  test('Redis connection should be closed when server ends', async () => {
    const server = await makeQueueServer();
    const publisher = redisPubSubClient.publishers[0];
    expect(publisher.close).not.toBeCalled();

    await server.close();

    expect(publisher.close).toBeCalled();
  });

  describe('Route', () => {
    const getFixtures = makeMockQueueServer();
    const postQueueEvent = makeQueueEventPoster(getFixtures);

    const event = new CloudEvent({
      source: CE_SOURCE,
      type: CE_TYPE,
      datacontenttype: 'text/plain',
      data: Buffer.from([]),
    });

    test('Malformed CloudEvent should be refused', async () => {
      const { server, logs } = getFixtures();

      const response = await server.inject({ method: 'POST', url: '/' });

      expect(response.statusCode).toBe(HTTP_STATUS_CODES.ACCEPTED);
      expect(logs).toContainEqual(partialPinoLog('info', 'Refused malformed CloudEvent'));
    });

    test('Unsupported event type should be refused', async () => {
      const eventType = 'invalid';
      const invalidEvent = event.cloneWith({ type: eventType });

      await expect(postQueueEvent(invalidEvent)).resolves.toBe(HTTP_STATUS_CODES.ACCEPTED);

      expect(getFixtures().logs).toContainEqual(
        partialPinoLog('info', 'Refused unsupported event type', { eventType }),
      );
    });

    test('HTTP 204 No Content should be returned if handler returns true', async () => {
      mockHandler.mockResolvedValue(true);

      await expect(postQueueEvent(event)).resolves.toBe(HTTP_STATUS_CODES.NO_CONTENT);
    });

    test('HTTP 503 Service Unavailable should be returned if handler returns false', async () => {
      mockHandler.mockResolvedValue(false);

      await expect(postQueueEvent(event)).resolves.toBe(HTTP_STATUS_CODES.SERVICE_UNAVAILABLE);
    });
  });
});
