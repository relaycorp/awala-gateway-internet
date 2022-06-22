import { EventEmitter } from 'events';
import { catchErrorEvent } from '../../testUtils/errors';
import { getMockInstance } from '../../testUtils/jest';

import { partialPinoLog } from '../../testUtils/logging';
import { setUpTestEnvironment } from './_test_utils';
import { makeServiceImplementation } from './service';

const { getSvcImplOptions, getMockLogs } = setUpTestEnvironment();

describe('makeServiceImplementation', () => {
  describe('Mongoose connection', () => {
    test('Connection should be created preemptively before any RPC', async () => {
      expect(getSvcImplOptions().getMongooseConnection).not.toBeCalled();

      await makeServiceImplementation(getSvcImplOptions());

      expect(getSvcImplOptions().getMongooseConnection).toBeCalled();
    });

    test('Errors while establishing connection should be propagated', async () => {
      const error = new Error('Database credentials are wrong');
      getMockInstance(getSvcImplOptions().getMongooseConnection).mockRejectedValue(error);

      await expect(makeServiceImplementation(getSvcImplOptions())).rejects.toEqual(error);
    });

    test('Errors after establishing connection should be logged', async () => {
      const mockConnection = new EventEmitter();
      getMockInstance(getSvcImplOptions().getMongooseConnection).mockResolvedValue(mockConnection);
      await makeServiceImplementation(getSvcImplOptions());

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
