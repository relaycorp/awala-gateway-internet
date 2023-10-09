export async function* arrayToAsyncIterable<T>(array: readonly T[]): AsyncIterable<T> {
  for (const item of array) {
    yield item;
  }
}

export async function* appendErrorToAsyncIterable<T>(
  error: Error,
  array: readonly T[],
): AsyncIterable<T> {
  yield* arrayToAsyncIterable(array);
  throw error;
}

export function iterableTake<T>(max: number): (iterable: AsyncIterable<T>) => AsyncIterable<T> {
  return async function* (iterable: AsyncIterable<T>): AsyncIterable<T> {
    if (max <= 0) {
      return;
    }

    let count = 0;
    for await (const item of iterable) {
      yield item;
      count++;
      if (max === count) {
        break;
      }
    }
  };
}
