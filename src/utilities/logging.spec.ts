import { getPinoOptions } from '@relaycorp/pino-cloud';
import { EnvVarError } from 'env-var';
import pino from 'pino';

import { configureMockEnvVars, getMockInstance } from '../services/_test_utils';
import { makeLogger } from './logging';

const REQUIRED_ENV_VARS = {
  GATEWAY_VERSION: '1.0.1',
};
const mockEnvVars = configureMockEnvVars(REQUIRED_ENV_VARS);

const COMPONENT = 'the-component';

jest.mock('@relaycorp/pino-cloud', () => ({
  getPinoOptions: jest.fn().mockReturnValue({}),
}));

describe('makeLogger', () => {
  test('Log level should be info if LOG_LEVEL env var is absent', () => {
    mockEnvVars(REQUIRED_ENV_VARS);

    const logger = makeLogger(COMPONENT);

    expect(logger).toHaveProperty('level', 'info');
  });

  test('Log level in LOG_LEVEL env var should be honoured if present', () => {
    const loglevel = 'debug';
    mockEnvVars({ ...REQUIRED_ENV_VARS, LOG_LEVEL: loglevel });

    const logger = makeLogger(COMPONENT);

    expect(logger).toHaveProperty('level', loglevel);
  });

  test('Log level in LOG_LEVEL env var should be lower-cased if present', () => {
    const loglevel = 'DEBUG';
    mockEnvVars({ ...REQUIRED_ENV_VARS, LOG_LEVEL: loglevel });

    const logger = makeLogger(COMPONENT);

    expect(logger).toHaveProperty('level', loglevel.toLowerCase());
  });

  test('GATEWAY_VERSION env var should be required', () => {
    mockEnvVars({ ...REQUIRED_ENV_VARS, GATEWAY_VERSION: undefined });

    expect(() => makeLogger(COMPONENT)).toThrowWithMessage(EnvVarError, /GATEWAY_VERSION/);
  });

  test('Cloud logging options should be used', () => {
    const messageKey = 'foo';
    getMockInstance(getPinoOptions).mockReturnValue({ messageKey });
    const logger = makeLogger(COMPONENT);

    expect(logger[pino.symbols.messageKeySym as any]).toEqual(messageKey);
    expect(getPinoOptions).toBeCalledWith(undefined, {
      name: COMPONENT,
      version: REQUIRED_ENV_VARS.GATEWAY_VERSION,
    });
  });

  test('LOG_TARGET env var should be honoured if present', () => {
    const loggingTarget = 'the-logging-target';
    mockEnvVars({ ...REQUIRED_ENV_VARS, LOG_TARGET: loggingTarget });

    makeLogger(COMPONENT);

    expect(getPinoOptions).toBeCalledWith(loggingTarget, expect.anything());
  });

  test('Logging target should be unset if LOG_TARGET env var is absent', () => {
    makeLogger(COMPONENT);

    expect(getPinoOptions).toBeCalledWith(undefined, expect.anything());
  });
});
