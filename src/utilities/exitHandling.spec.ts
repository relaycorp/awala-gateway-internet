import { getMockContext, mockSpy } from '../testUtils/jest';
import { makeMockLogging, MockLogging, partialPinoLog } from '../testUtils/logging';
import { configureExitHandling } from './exitHandling';

const ERROR = new Error('Oh noes');

let mockLogging: MockLogging;
beforeEach(() => {
  mockLogging = makeMockLogging();
});

const mockProcessOn = mockSpy(jest.spyOn(process, 'on'));
const mockProcessExit = mockSpy(jest.spyOn(process, 'exit'));

describe('configureExitHandling', () => {
  beforeEach(() => {
    configureExitHandling(mockLogging.logger);
  });

  describe('uncaughtException', () => {
    test('Error should be logged as fatal', () => {
      const call = getMockContext(mockProcessOn).calls[0];
      const handler = call[1];

      handler(ERROR);

      expect(mockLogging.logs).toContainEqual(
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
