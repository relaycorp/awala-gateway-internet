export async function getPromiseRejection<E extends Error>(
  promise: Promise<any>,
  expectedErrorClass: new (...args: readonly any[]) => E,
): Promise<E> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof expectedErrorClass)) {
      throw new Error(`"${error}" does not extend ${expectedErrorClass.name}`);
    }
    return error;
  }
  throw new Error('Expected project to reject');
}

// tslint:disable-next-line:readonly-array
export function mockSpy<T, Y extends any[]>(
  spy: jest.MockInstance<T, Y>,
  mockImplementation?: (...args: readonly any[]) => any,
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

export function useFakeTimers(): void {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });
}

export function getMockInstance(mockedObject: any): jest.MockInstance<any, any> {
  return mockedObject as unknown as jest.MockInstance<any, any>;
}

export function getMockContext(mockedObject: any): jest.MockContext<any, any> {
  const mockInstance = getMockInstance(mockedObject);
  return mockInstance.mock;
}

export function castMock<T>(partialMock: Partial<T>): T {
  return partialMock as unknown as T;
}
