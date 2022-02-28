import * as stan from 'node-nats-streaming';

import { castMock } from '../testUtils/jest';

export function mockStanMessage(messageData: Buffer | ArrayBuffer): stan.Message {
  return castMock<stan.Message>({
    ack: jest.fn(),
    getRawData: () => Buffer.from(messageData),
  });
}
