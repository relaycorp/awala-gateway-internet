import { setUpTestEnvironment } from './_test_utils';
import { makeService } from './service';

const { getSvcImplOptions } = setUpTestEnvironment();

describe('makeService', () => {
  describe('Mongoose connection', () => {
    test('Connection should be created preemptively before any RPC', async () => {
      expect(getSvcImplOptions().getMongooseConnection).not.toBeCalled();

      await makeService(getSvcImplOptions());

      expect(getSvcImplOptions().getMongooseConnection).toBeCalled();
    });
  });
});
