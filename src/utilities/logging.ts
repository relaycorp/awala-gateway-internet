import { getPinoOptions, LoggingTarget } from '@relaycorp/pino-cloud';
import { get as getEnvVar } from 'env-var';
import pino, { Level, Logger } from 'pino';

export function makeLogger(component: string): Logger {
  const logTarget = getEnvVar('LOG_TARGET').asString();
  const gatewayVersion = getEnvVar('GATEWAY_VERSION').required().asString();
  const appContext = { name: component, version: gatewayVersion };
  const cloudPinoOptions = getPinoOptions(logTarget as LoggingTarget, appContext);

  const logLevel = getEnvVar('LOG_LEVEL').default('info').asString().toLowerCase() as Level;
  return pino({ ...cloudPinoOptions, level: logLevel });
}
