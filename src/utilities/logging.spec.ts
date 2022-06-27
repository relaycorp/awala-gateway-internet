import { getPinoOptions } from '@relaycorp/pino-cloud';
import { EnvVarError } from 'env-var';
import pino from 'pino';

import { configureMockEnvVars } from '../testUtils/envVars';
import { getMockInstance } from '../testUtils/jest';
import { makeLogger } from './logging';

const REQUIRED_ENV_VARS = {
  GATEWAY_VERSION: '1.0.1',
};
const mockEnvVars = configureMockEnvVars(REQUIRED_ENV_VARS);

jest.mock('@relaycorp/pino-cloud', () => ({
  getPinoOptions: jest.fn().mockReturnValue({}),
}));

describe('makeLogger', () => {
  test('Log level should be info if LOG_LEVEL env var is absent', () => {
    mockEnvVars(REQUIRED_ENV_VARS);

    const logger = makeLogger();

    expect(logger).toHaveProperty('level', 'info');
  });

  test('Log level in LOG_LEVEL env var should be honoured if present', () => {
    const loglevel = 'debug';
    mockEnvVars({ ...REQUIRED_ENV_VARS, LOG_LEVEL: loglevel });

    const logger = makeLogger();

    expect(logger).toHaveProperty('level', loglevel);
  });

  test('Log level in LOG_LEVEL env var should be lower-cased if present', () => {
    const loglevel = 'DEBUG';
    mockEnvVars({ ...REQUIRED_ENV_VARS, LOG_LEVEL: loglevel });

    const logger = makeLogger();

    expect(logger).toHaveProperty('level', loglevel.toLowerCase());
  });

  test('GATEWAY_VERSION env var should be required', () => {
    mockEnvVars({ ...REQUIRED_ENV_VARS, GATEWAY_VERSION: undefined });

    expect(() => makeLogger()).toThrowWithMessage(EnvVarError, /GATEWAY_VERSION/);
  });

  test('Cloud logging options should be used', () => {
    const messageKey = 'foo';
    getMockInstance(getPinoOptions).mockReturnValue({ messageKey });
    const logger = makeLogger();

    expect(logger).toHaveProperty([pino.symbols.messageKeySym], messageKey);
  });

  test('App name should be set to LOG_ENV_NAME if present', () => {
    const envName = 'env-name';
    mockEnvVars({ ...REQUIRED_ENV_VARS, LOG_ENV_NAME: envName });
    makeLogger();

    expect(getPinoOptions).toBeCalledWith(undefined, expect.objectContaining({ name: envName }));
  });

  test('App name should be "relaynet-internet-gateway" if LOG_ENV_NAME if absent', () => {
    makeLogger();

    expect(getPinoOptions).toBeCalledWith(
      undefined,
      expect.objectContaining({ name: 'relaynet-internet-gateway' }),
    );
  });

  test('GATEWAY_VERSION should be passed to cloud logging config', () => {
    makeLogger();

    expect(getPinoOptions).toBeCalledWith(
      undefined,
      expect.objectContaining({
        version: REQUIRED_ENV_VARS.GATEWAY_VERSION,
      }),
    );
  });

  test('LOG_TARGET env var should be honoured if present', () => {
    const loggingTarget = 'the-logging-target';
    mockEnvVars({ ...REQUIRED_ENV_VARS, LOG_TARGET: loggingTarget });

    makeLogger();

    expect(getPinoOptions).toBeCalledWith(loggingTarget, expect.anything());
  });

  test('Logging target should be unset if LOG_TARGET env var is absent', () => {
    makeLogger();

    expect(getPinoOptions).toBeCalledWith(undefined, expect.anything());
  });
});
