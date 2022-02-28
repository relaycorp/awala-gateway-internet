import bufferToArray from 'buffer-to-arraybuffer';
import { BinaryLike, createHash, Hash } from 'crypto';
import { Connection, createConnection } from 'mongoose';
import pino, { symbols as PinoSymbols } from 'pino';
import split2 from 'split2';

export const UUID4_REGEX = expect.stringMatching(/^[0-9a-f-]+$/);

export const MONGO_ENV_VARS = {
  MONGO_DB: 'the_db',
  MONGO_PASSWORD: 'letmein',
  MONGO_URI: 'mongodb://example.com',
  MONGO_USER: 'alicia',
};

export function arrayBufferFrom(value: string): ArrayBuffer {
  return bufferToArray(Buffer.from(value));
}

export async function getPromiseRejection<E extends Error>(
  promise: Promise<any>,
  expectedErrorClass?: new (...args: readonly any[]) => E,
): Promise<E> {
  try {
    await promise;
  } catch (error) {
    if (expectedErrorClass && !(error instanceof expectedErrorClass)) {
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

// tslint:disable-next-line:readonly-array
export type MockLogSet = object[];

export interface MockLogging {
  readonly logger: pino.Logger;
  readonly logs: MockLogSet;
}

export function makeMockLogging(): MockLogging {
  // tslint:disable-next-line:readonly-array
  const logs: object[] = [];
  const stream = split2((data) => {
    logs.push(JSON.parse(data));
  });
  const logger = pino({ level: 'debug' }, stream);
  return { logger, logs };
}

export function partialPinoLogger(bindings: { readonly [key: string]: any }): object {
  return expect.objectContaining({
    [PinoSymbols.formattersSym]: { bindings },
  });
}

export function partialPinoLog(level: pino.Level, message: string, extraAttributes?: any): object {
  const levelNumber = pino.levels.values[level];
  return expect.objectContaining({
    level: levelNumber,
    msg: message,
    ...(extraAttributes && extraAttributes),
  });
}

function makeSHA256Hash(plaintext: BinaryLike): Hash {
  return createHash('sha256').update(plaintext);
}

export function sha256Hex(plaintext: string): string {
  return makeSHA256Hash(plaintext).digest('hex');
}

export function sha256(plaintext: BinaryLike): Buffer {
  return makeSHA256Hash(plaintext).digest();
}

export function useFakeTimers(): void {
  beforeEach(() => {
    jest.useFakeTimers('modern');
  });

  afterEach(() => {
    jest.useRealTimers();
  });
}

export function setUpTestDBConnection(): () => Connection {
  let connection: Connection;

  const connect = () =>
    createConnection((global as any).__MONGO_URI__, {
      useCreateIndex: true,
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

  beforeAll(async () => {
    connection = await connect();
  });

  beforeEach(async () => {
    if (connection.readyState === 0) {
      connection = await connect();
    }
  });

  afterEach(async () => {
    await Promise.all(Object.values(connection.collections).map((c) => c.deleteMany({})));
  });

  afterAll(async () => {
    await connection.close(true);
  });

  return () => connection;
}
