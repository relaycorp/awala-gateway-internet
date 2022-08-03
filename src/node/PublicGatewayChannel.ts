import { GatewayChannel, Recipient } from '@relaycorp/relaynet-core';

export class PublicGatewayChannel extends GatewayChannel {
  async getOutboundRAMFRecipient(): Promise<Recipient> {
    return { id: this.peerId };
  }
}
