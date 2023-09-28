import pino, { symbols as PinoSymbols } from 'pino';
import split2 from 'split2';

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

export function partialPinoLogger(expectedBindings: { readonly [key: string]: any }): object {
  return expect.objectContaining({
    [PinoSymbols.chindingsSym]: expect.toSatisfy((bindingsRaw) => {
      const bindingsJson = `{${bindingsRaw.substring(1)}}`;
      const bindings = JSON.parse(bindingsJson);
      return Object.entries(expectedBindings).every(([key, value]) => {
        return bindings[key] === value;
      });
    }),
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
