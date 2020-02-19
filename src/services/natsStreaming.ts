import { connect } from 'node-nats-streaming';
import { promisify } from 'util';

export class NatsStreamingClient {
  constructor(
    protected readonly serverUrl: string,
    protected readonly clusterId: string,
    protected readonly clientId: string,
  ) {}

  public makePublisher(
    channel: string,
  ): (messages: IterableIterator<Buffer> | readonly Buffer[]) => Promise<void> {
    const connection = connect(this.clusterId, this.clientId, { url: this.serverUrl });
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
}
