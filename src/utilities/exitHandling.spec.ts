import pino from 'pino';

import { makeMockLogging, MockLogging, mockSpy, partialPinoLog } from '../_test_utils';
import { getMockContext } from '../services/_test_utils';
import { configureExitHandling } from './exitHandling';

const ERROR = new Error('Oh noes');

let mockLogging: MockLogging;
let mockFinalLogging: MockLogging;
beforeEach(() => {
  mockLogging = makeMockLogging();
  mockFinalLogging = makeMockLogging();
});

const mockProcessOn = mockSpy(jest.spyOn(process, 'on'));
const mockProcessExit = mockSpy(jest.spyOn(process, 'exit'));

mockSpy(jest.spyOn(pino, 'final'), (_, handler) => (err: Error) =>
  handler(err, mockFinalLogging.logger),
);

describe('configureExitHandling', () => {
  beforeEach(() => {
    configureExitHandling(mockLogging.logger);
  });

  describe('uncaughtException', () => {
    test('Error should be logged as fatal', () => {
      const call = getMockContext(mockProcessOn).calls[0];
      const handler = call[1];

      handler(ERROR);

      expect(mockLogging.logs).toBeEmpty();
      expect(mockFinalLogging.logs).toContainEqual(
        partialPinoLog('fatal', 'uncaughtException', {
          err: expect.objectContaining({ message: ERROR.message }),
        }),
      );
    });

    test('Process should exit with code 1', () => {
      const call = getMockContext(mockProcessOn).calls[0];
      const handler = call[1];
      expect(mockProcessExit).not.toBeCalled();

      handler(ERROR);

      expect(mockProcessExit).toBeCalledWith(1);
    });
  });
});
