import { mockSpy } from '../../testUtils/jest';
import { CE_TRANSPORT } from '../../testUtils/eventing/stubs';
import { configureMockEnvVars } from '../../testUtils/envVars';
import { DEFAULT_TRANSPORT } from './transport';

const stubMessage = Symbol('stubMessage');
const mockReceiver = mockSpy(jest.fn(), () => stubMessage);
const mockMakeReceiver = mockSpy(jest.fn(), () => mockReceiver);
jest.mock('@relaycorp/cloudevents-transport', () => ({
  makeReceiver: mockMakeReceiver,
}));
import { QueueReceiver } from './QueueReceiver';

describe('QueueReceiver', () => {
  const mockEnvVars = configureMockEnvVars({ CE_TRANSPORT });

  afterEach(() => {
    QueueReceiver.clearCache();
  });

  describe('init', () => {
    test('CE Binary Mode should be used as default transport', async () => {
      mockEnvVars({ CE_TRANSPORT: undefined });

      await QueueReceiver.init();

      expect(mockMakeReceiver).toHaveBeenCalledWith(DEFAULT_TRANSPORT);
    });

    test('Environment variable CE_TRANSPORT should be used as transport', async () => {
      await QueueReceiver.init();

      expect(mockMakeReceiver).toHaveBeenCalledWith(CE_TRANSPORT);
    });

    test('Underlying receiver should be cached', async () => {
      expect(mockMakeReceiver).not.toHaveBeenCalled();
      await QueueReceiver.init();
      expect(mockMakeReceiver).toHaveBeenCalledOnce();

      await QueueReceiver.init();
      expect(mockMakeReceiver).toHaveBeenCalledOnce();
    });
  });

  describe('convertMessageToEvent', () => {
    const headers = { foo: 'bar' };
    const body = Buffer.from('body');

    test('should convert message with underlying receiver', async () => {
      const receiver = await QueueReceiver.init();

      const event = receiver.convertMessageToEvent(headers, body);

      expect(event).toBe(stubMessage);
      expect(mockReceiver).toHaveBeenCalledWith(headers, body);
    });
  });
});
