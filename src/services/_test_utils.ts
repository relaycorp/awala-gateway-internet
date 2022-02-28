import { Certificate, Parcel } from '@relaycorp/relaynet-core';
import * as stan from 'node-nats-streaming';

import { castMock } from '../testUtils/jest';

export interface StubParcelOptions {
  readonly recipientAddress: string;
  readonly senderCertificate: Certificate;
  readonly senderCertificateChain?: readonly Certificate[];
}

export async function generateStubParcel(options: StubParcelOptions): Promise<Parcel> {
  return new Parcel(
    options.recipientAddress,
    options.senderCertificate,
    Buffer.from('the payload'),
    { senderCaCertificateChain: options.senderCertificateChain ?? [] },
  );
}

export function mockStanMessage(messageData: Buffer | ArrayBuffer): stan.Message {
  return castMock<stan.Message>({
    ack: jest.fn(),
    getRawData: () => Buffer.from(messageData),
  });
}
