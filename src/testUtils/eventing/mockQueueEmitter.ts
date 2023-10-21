import type { CloudEvent } from 'cloudevents';

import { QueueEmitter } from '../../utilities/backgroundQueue/QueueEmitter';

// eslint-disable-next-line @typescript-eslint/require-await
const NO_OP_FUNCTION = async (): Promise<void> => undefined;

export class MockQueueEmitter extends QueueEmitter {
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

export function mockQueueEmitter(): MockQueueEmitter {
  const initMock = jest.spyOn(QueueEmitter, 'init');

  const emitter = new MockQueueEmitter();

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/require-await
    initMock.mockImplementation(async () => emitter);
  });

  afterEach(() => {
    emitter.reset();
  });

  afterAll(() => {
    initMock.mockRestore();
  });

  return emitter;
}
