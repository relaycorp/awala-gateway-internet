import { Message } from 'node-nats-streaming';

import { castMock } from './jest';

export function mockStanMessage(messageData: Buffer | ArrayBuffer): Message {
  return castMock<Message>({
    ack: jest.fn(),
    getRawData: () => Buffer.from(messageData),
  });
}
