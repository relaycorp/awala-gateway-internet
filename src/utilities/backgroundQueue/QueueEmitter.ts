import type { CloudEvent, EmitterFunction } from 'cloudevents';
import { makeEmitter as ceMakeEmitter } from '@relaycorp/cloudevents-transport';
import envVar from 'env-var';

import { DEFAULT_TRANSPORT } from './transport';

export class QueueEmitter {
  protected static cache: QueueEmitter | undefined;

  /**
   * For unit testing only.
   */
  public static clearCache(): void {
    QueueEmitter.cache = undefined;
  }

  public static async init(): Promise<QueueEmitter> {
    const cachedEmitter = QueueEmitter.cache;
    if (cachedEmitter) {
      return cachedEmitter;
    }

    const transport = envVar.get('CE_TRANSPORT').default(DEFAULT_TRANSPORT).asString();
    const channel = envVar.get('CE_CHANNEL').required().asString();
    const emitterFunction = await ceMakeEmitter(transport, channel);
    const emitter = new QueueEmitter(emitterFunction);
    QueueEmitter.cache = emitter;
    return emitter;
  }

  public constructor(protected readonly func: EmitterFunction) {}

  public async emit(event: CloudEvent<Buffer>): Promise<void> {
    await this.func(event);
  }
}
