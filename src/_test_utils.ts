import { Certificate } from '@relaycorp/relaynet-core';
import { BinaryLike, createHash, Hash } from 'crypto';
import pino from 'pino';
import split2 from 'split2';

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

// tslint:disable-next-line:readonly-array
export function makeMockLogging(): { readonly logger: pino.Logger; readonly logs: object[] } {
  // tslint:disable-next-line:readonly-array
  const logs: object[] = [];
  const stream = split2((data) => {
    logs.push(JSON.parse(data));
  });
  const logger = pino({ level: 'debug' }, stream);
  return { logger, logs };
}

export function partialPinoLog(level: pino.Level, message: string, extraAttributes?: any): object {
  const levelNumber = pino.levels.values[level];
  return expect.objectContaining({
    level: levelNumber,
    msg: message,
    ...(extraAttributes && extraAttributes),
  });
}

export interface PdaChain {
  readonly publicGatewayCert: Certificate;
  readonly publicGatewayPrivateKey: CryptoKey;
  readonly privateGatewayCert: Certificate;
  readonly privateGatewayPrivateKey: CryptoKey;
  readonly peerEndpointCert: Certificate;
  readonly peerEndpointPrivateKey: CryptoKey;
  readonly pdaCert: Certificate;
  readonly pdaGranteePrivateKey: CryptoKey;
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
