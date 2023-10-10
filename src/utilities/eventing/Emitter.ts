import type { CloudEvent, EmitterFunction } from 'cloudevents';
import { makeEmitter as ceMakeEmitter } from '@relaycorp/cloudevents-transport';
import envVar from 'env-var';

import { DEFAULT_TRANSPORT } from './transport';
import type { EmitterChannel } from './EmitterChannel';

export class Emitter<Payload> {
  protected static readonly cache = new Map<EmitterChannel, Emitter<unknown>>();

  /**
   * For unit testing only.
   */
  public static clearCache(): void {
    Emitter.cache.clear();
  }

  public static async init(channelEnvVar: EmitterChannel): Promise<Emitter<unknown>> {
    const cachedEmitter = Emitter.cache.get(channelEnvVar);
    if (cachedEmitter) {
      return cachedEmitter;
    }

    const transport = envVar.get('CE_TRANSPORT').default(DEFAULT_TRANSPORT).asString();
    const channel = envVar.get(channelEnvVar).required().asString();
    const emitterFunction = await ceMakeEmitter(transport, channel);
    const emitter = new Emitter(emitterFunction);
    Emitter.cache.set(channelEnvVar, emitter);
    return emitter;
  }

  public constructor(protected readonly func: EmitterFunction) {}

  public async emit(event: CloudEvent<Payload>): Promise<void> {
    await this.func(event);
  }
}
