import { makeReceiver, type Receiver as CeReceiver } from '@relaycorp/cloudevents-transport';
import envVar from 'env-var';

import { DEFAULT_TRANSPORT } from './transport';
import { CloudEventV1, Headers } from 'cloudevents';

export class Receiver {
  protected static cache: Receiver | undefined = undefined;

  /**
   * For unit testing only.
   */
  public static clearCache(): void {
    Receiver.cache = undefined;
  }

  public static async init(): Promise<Receiver> {
    if (Receiver.cache) {
      return Receiver.cache;
    }

    const transport = envVar.get('CE_TRANSPORT').default(DEFAULT_TRANSPORT).asString();
    const ceReceiver = await makeReceiver(transport);
    Receiver.cache = new Receiver(ceReceiver);
    return Receiver.cache;
  }

  protected constructor(protected readonly ceReceiver: CeReceiver) {}

  public convertMessageToEvent(headers: Headers, body: Buffer): CloudEventV1<Buffer> {
    return this.ceReceiver(headers, body);
  }
}
