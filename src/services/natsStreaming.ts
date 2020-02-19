import { connect } from 'node-nats-streaming';
import { promisify } from 'util';

export function makeNatsPublisher(
  clusterId: string,
  clientId: string,
  channel: string,
): (messages: IterableIterator<Buffer>) => Promise<void> {
  const connection = connect(clusterId, clientId);
  const publishPromisified = promisify(connection.publish).bind(connection);

  return async messages => {
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
