import { CloudEvent } from 'cloudevents';
import envVar from 'env-var';

import { mockSpy } from '../../testUtils/jest';
import { CE_CHANNEL, CE_ID, CE_SOURCE, CE_TRANSPORT } from '../../testUtils/eventing/stubs';
import { configureMockEnvVars } from '../../testUtils/envVars';

const mockEmitter = mockSpy(jest.fn());
const mockMakeEmitter = mockSpy(jest.fn(), () => mockEmitter);
jest.mock('@relaycorp/cloudevents-transport', () => ({
  makeEmitter: mockMakeEmitter,
}));
import { QueueEmitter } from './QueueEmitter';

describe('QueueEmitter', () => {
  const baseEnvVars = { CE_TRANSPORT, CE_CHANNEL };
  const mockEnvVars = configureMockEnvVars(baseEnvVars);

  beforeEach(() => {
    QueueEmitter.clearCache();
  });

  describe('init', () => {
    test('Transport should be CE binary mode if CE_TRANSPORT unset', async () => {
      mockEnvVars({ ...baseEnvVars, CE_TRANSPORT: undefined });
      await QueueEmitter.init();

      expect(mockMakeEmitter).toHaveBeenCalledWith('ce-http-binary', expect.anything());
    });

    test('Transport should be taken from CE_TRANSPORT if present', async () => {
      await QueueEmitter.init();

      expect(mockMakeEmitter).toHaveBeenCalledWith(CE_TRANSPORT, expect.anything());
    });

    test('Channel should be taken from CE_CHANNEL', async () => {
      await QueueEmitter.init();

      expect(mockMakeEmitter).toHaveBeenCalledWith(expect.anything(), CE_CHANNEL);
    });

    test('Error should be thrown if CE_CHANNEL is unset', async () => {
      mockEnvVars({ ...baseEnvVars, CE_CHANNEL: undefined });

      await expect(QueueEmitter.init()).rejects.toThrowWithMessage(
        envVar.EnvVarError,
        /CE_CHANNEL/u,
      );
    });

    test('Emitter should be cached', async () => {
      expect(mockMakeEmitter).toHaveBeenCalledTimes(0);
      await QueueEmitter.init();
      expect(mockMakeEmitter).toHaveBeenCalledTimes(1);

      await QueueEmitter.init();

      expect(mockMakeEmitter).toHaveBeenCalledTimes(1);
    });
  });

  describe('emit', () => {
    const event = new CloudEvent({
      id: CE_ID,
      source: CE_SOURCE,
      type: 'type',
      data: Buffer.from([]),
    });

    test('should call underlying emitter with event', async () => {
      const emitter = await QueueEmitter.init();

      await emitter.emit(event);

      expect(mockEmitter).toHaveBeenCalledWith(event);
    });
  });
});
