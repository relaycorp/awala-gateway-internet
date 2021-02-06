// tslint:disable-next-line:no-submodule-imports
import { Bindings as FastifyBindings, FastifyLogFn } from 'fastify/types/logger';
import { Bindings as PinoBindings, LogFn as PinoLogFn } from 'pino';

type LogMethod = PinoLogFn | FastifyLogFn;

type Bindings = PinoBindings | FastifyBindings;

/**
 * Common interface shared by Pino and Fastify's logger.
 *
 * AKA: Annoying workaround because Fastify's types don't extend Pino's.
 */
export interface BasicLogger {
  readonly debug: LogMethod;
  readonly info: LogMethod;
  readonly warn: LogMethod;
  readonly error: LogMethod;
  readonly fatal: LogMethod;
  readonly child: (bindings: Bindings) => BasicLogger;
}
