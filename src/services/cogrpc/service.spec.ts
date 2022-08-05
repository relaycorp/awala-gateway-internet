import { EventEmitter } from 'events';
import { catchErrorEvent } from '../../testUtils/errors';
import { getMockInstance } from '../../testUtils/jest';

import { partialPinoLog } from '../../testUtils/logging';
import { setUpTestEnvironment } from './_test_utils';
import { makeService } from './service';

const { getSvcImplOptions, getMockLogs } = setUpTestEnvironment();

describe('makeService', () => {
  describe('Mongoose connection', () => {
    test('Connection should be created preemptively before any RPC', async () => {
      expect(getSvcImplOptions().getMongooseConnection).not.toBeCalled();

      await makeService(getSvcImplOptions());

      expect(getSvcImplOptions().getMongooseConnection).toBeCalled();
    });

    test('Errors while establishing connection should be propagated', async () => {
      const error = new Error('Database credentials are wrong');
      getMockInstance(getSvcImplOptions().getMongooseConnection).mockRejectedValue(error);

      await expect(makeService(getSvcImplOptions())).rejects.toEqual(error);
    });

    test('Errors after establishing connection should be logged', async () => {
      const mockConnection = new EventEmitter();
      getMockInstance(getSvcImplOptions().getMongooseConnection).mockResolvedValue(mockConnection);
      await makeService(getSvcImplOptions());

      const connectionError = await catchErrorEvent(mockConnection, () =>
        mockConnection.emit('error', new Error('Database credentials are wrong')),
      );

      expect(getMockLogs()).toContainEqual(
        partialPinoLog('error', 'Mongoose connection error', {
          err: expect.objectContaining({ message: connectionError.message }),
        }),
      );
    });
  });
});
