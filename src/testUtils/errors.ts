import { EventEmitter } from 'events';

export async function catchErrorEvent(emitter: EventEmitter, trigger: () => any): Promise<Error> {
  return new Promise((resolve) => {
    emitter.once('error', resolve);
    trigger();
  });
}
