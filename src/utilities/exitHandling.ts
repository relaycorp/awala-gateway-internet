import makePromisesSafe from 'make-promises-safe';
import pino, { Logger } from 'pino';

export function configureExitHandling(logger: Logger): void {
  process.on(
    'uncaughtException',
    pino.final(logger, (err, finalLogger) => {
      finalLogger.fatal({ err }, 'uncaughtException');

      process.exit(1);
    }),
  );

  makePromisesSafe.logError = pino.final(logger, (err, finalLogger) => {
    finalLogger.fatal({ err }, 'unhandledRejection');
  });
}
