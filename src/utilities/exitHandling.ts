import { Logger } from 'pino';

export function configureExitHandling(logger: Logger): void {
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException');

    process.exit(1);
  });
}
