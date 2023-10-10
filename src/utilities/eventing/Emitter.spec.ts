import { CloudEvent } from 'cloudevents';
import envVar from 'env-var';

import { mockSpy } from '../../testUtils/jest';
import { CE_CHANNEL, CE_ID, CE_SOURCE, CE_TRANSPORT } from '../../testUtils/eventing/stubs';
import { configureMockEnvVars } from '../../testUtils/envVars';

import { EmitterChannel } from './EmitterChannel';

const mockEmitter = mockSpy(jest.fn());
const mockMakeEmitter = mockSpy(jest.fn(), () => mockEmitter);
jest.mock('@relaycorp/cloudevents-transport', () => ({
  makeEmitter: mockMakeEmitter,
}));
import { Emitter } from './Emitter';

describe('Emitter', () => {
  const channelEnvVarName = EmitterChannel.CRC_INCOMING;
  const baseEnvVars = { CE_TRANSPORT, [channelEnvVarName]: CE_CHANNEL };
  const mockEnvVars = configureMockEnvVars(baseEnvVars);

  beforeEach(() => {
    Emitter.clearCache();
  });

  describe('init', () => {
    test('Transport should be CE binary mode if CE_TRANSPORT unset', async () => {
      mockEnvVars({ ...baseEnvVars, CE_TRANSPORT: undefined });
      await Emitter.init(channelEnvVarName);

      expect(mockMakeEmitter).toHaveBeenCalledWith('ce-http-binary', expect.anything());
    });

    test('Transport should be taken from CE_TRANSPORT if present', async () => {
      await Emitter.init(channelEnvVarName);

      expect(mockMakeEmitter).toHaveBeenCalledWith(CE_TRANSPORT, expect.anything());
    });

    test('Channel should be taken from specified environment variable', async () => {
      await Emitter.init(channelEnvVarName);

      expect(mockMakeEmitter).toHaveBeenCalledWith(expect.anything(), CE_CHANNEL);
    });

    test('Error should be thrown if specified channel env var is missing', async () => {
      mockEnvVars({ ...baseEnvVars, [channelEnvVarName]: undefined });

      await expect(Emitter.init(channelEnvVarName)).rejects.toThrowWithMessage(
        envVar.EnvVarError,
        /CE_CHANNEL/u,
      );
    });

    test('Emitter should be cached', async () => {
      expect(mockMakeEmitter).toHaveBeenCalledTimes(0);
      await Emitter.init(channelEnvVarName);
      expect(mockMakeEmitter).toHaveBeenCalledTimes(1);

      await Emitter.init(channelEnvVarName);

      expect(mockMakeEmitter).toHaveBeenCalledTimes(1);
    });
  });

  describe('emit', () => {
    const event = new CloudEvent({ id: CE_ID, source: CE_SOURCE, type: 'type' });

    test('should call underlying emitter with event', async () => {
      const emitter = await Emitter.init(channelEnvVarName);

      await emitter.emit(event);

      expect(mockEmitter).toHaveBeenCalledWith(event);
    });
  });
});
