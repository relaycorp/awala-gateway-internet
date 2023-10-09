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
