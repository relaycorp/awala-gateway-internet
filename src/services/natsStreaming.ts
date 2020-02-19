import { connect } from 'node-nats-streaming';
import { promisify } from 'util';

export function makeNatsPublisher(
  clusterId: string,
  clientId: string,
  channel: string,
): (messages: IterableIterator<Buffer> | readonly Buffer[]) => Promise<void> {
  const connection = connect(clusterId, clientId);
  const publishPromisified = promisify(connection.publish).bind(connection);

  // tslint:disable-next-line:no-let
  let didPublishingStart = false;

  return async messages => {
    if (didPublishingStart) {
      throw new Error('Publisher cannot be reused as the connection was already closed');
    }
    didPublishingStart = true;

    return new Promise<void>((resolve, reject) => {
      connection.on('connect', async () => {
        try {
          for (const message of messages) {
            try {
              await publishPromisified(channel, message);
            } catch (error) {
              return reject(error);
            }
          }
          resolve();
        } finally {
          connection.close();
        }
      });
    });
  };
}
