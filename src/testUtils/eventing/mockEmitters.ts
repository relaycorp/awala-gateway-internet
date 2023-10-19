import type { CloudEvent } from 'cloudevents';

import { Emitter } from '../../utilities/eventing/Emitter';
import type { EmitterChannel } from '../../utilities/eventing/EmitterChannel';

// eslint-disable-next-line @typescript-eslint/require-await
const NO_OP_FUNCTION = async (): Promise<void> => undefined;

export class MockEmitter extends Emitter<Buffer> {
  public readonly events: CloudEvent<Buffer>[] = [];

  public constructor() {
    super(NO_OP_FUNCTION);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public override async emit(event: CloudEvent<Buffer>): Promise<void> {
    this.events.push(event);
  }

  public reset(): void {
    this.events.splice(0, this.events.length);
  }
}

export type EmitterRetriever = (channelEnvVar: EmitterChannel) => MockEmitter | undefined;

export function mockEmitters(): EmitterRetriever {
  const initMock = jest.spyOn(Emitter<unknown>, 'init');

  const emitters = new Map<EmitterChannel, MockEmitter>();

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/require-await
    initMock.mockImplementation(async (channelEnvVar: EmitterChannel) => {
      const cachedEmitter = emitters.get(channelEnvVar);
      if (cachedEmitter) {
        return cachedEmitter;
      }

      const emitter = new MockEmitter();
      emitters.set(channelEnvVar, emitter);
      return emitter;
    });
  });

  afterEach(() => {
    emitters.clear();
  });

  afterAll(() => {
    initMock.mockRestore();
  });

  return (channelEnvVar) => emitters.get(channelEnvVar);
}
