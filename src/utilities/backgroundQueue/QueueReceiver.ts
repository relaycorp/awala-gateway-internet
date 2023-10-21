import type { Receiver as CeReceiver } from '@relaycorp/cloudevents-transport';
import { CloudEventV1, Headers } from 'cloudevents';
import envVar from 'env-var';

import { DEFAULT_TRANSPORT } from './transport';

export class QueueReceiver {
  protected static cache: QueueReceiver | undefined = undefined;

  /**
   * For unit testing only.
   */
  public static clearCache(): void {
    QueueReceiver.cache = undefined;
  }

  public static async init(): Promise<QueueReceiver> {
    if (QueueReceiver.cache) {
      return QueueReceiver.cache;
    }
    const { makeReceiver } = await import('@relaycorp/cloudevents-transport');

    const transport = envVar.get('CE_TRANSPORT').default(DEFAULT_TRANSPORT).asString();
    const ceReceiver = await makeReceiver(transport);
    QueueReceiver.cache = new QueueReceiver(ceReceiver);
    return QueueReceiver.cache;
  }

  protected constructor(protected readonly ceReceiver: CeReceiver) {}

  public convertMessageToEvent(headers: Headers, body: Buffer): CloudEventV1<Buffer> {
    return this.ceReceiver(headers, body);
  }
}
