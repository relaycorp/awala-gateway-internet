import pino from 'pino';

export async function* arrayToAsyncIterable<T>(array: readonly T[]): AsyncIterable<T> {
  for (const item of array) {
    yield item;
  }
}

export async function asyncIterableToArray<T>(iterable: AsyncIterable<T>): Promise<readonly T[]> {
  // tslint:disable-next-line:readonly-array
  const values = [];
  for await (const item of iterable) {
    values.push(item);
  }
  return values;
}

// tslint:disable-next-line:readonly-array
export function mockSpy<T, Y extends any[]>(
  spy: jest.MockInstance<T, Y>,
  mockImplementation?: () => any,
): jest.MockInstance<T, Y> {
  beforeEach(() => {
    spy.mockReset();
    if (mockImplementation) {
      spy.mockImplementation(mockImplementation);
    }
  });

  afterAll(() => {
    spy.mockRestore();
  });

  return spy;
}

export function mockPino(): pino.Logger {
  const mockPinoLogger = {
    debug: mockSpy(jest.fn()),
    error: mockSpy(jest.fn()),
    info: mockSpy(jest.fn()),
    warn: mockSpy(jest.fn()),
  };
  jest.mock('pino', () => jest.fn().mockImplementation(() => mockPinoLogger));
  return mockPinoLogger as any;
}
