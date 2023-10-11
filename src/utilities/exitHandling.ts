import type { BaseLogger } from 'pino';

export function configureExitHandling(logger: BaseLogger): void {
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException');

    process.exit(1);
  });
}
