import { connect, Stan } from 'node-nats-streaming';
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
    // tslint:disable-next-line:no-let
    let didPublishingStart = false;

    return async messages => {
      if (didPublishingStart) {
        throw new Error('Publisher cannot be reused as the connection was already closed');
      }
      didPublishingStart = true;

      const connection = await this.connect();
      const publishPromisified = promisify(connection.publish).bind(connection);

      try {
        for (const message of messages) {
          await publishPromisified(channel, message);
        }
      } finally {
        connection.close();
      }
    };
  }

  protected async connect(): Promise<Stan> {
    return new Promise<Stan>((resolve, _reject) => {
      const connection = connect(this.clusterId, this.clientId, { url: this.serverUrl });
      connection.on('connect', () => {
        resolve(connection);
      });
    });
  }
}
