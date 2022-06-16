import { GatewayChannel } from '@relaycorp/relaynet-core';

export class PublicGatewayChannel extends GatewayChannel {
  public getOutboundRAMFAddress(): string {
    return this.peerPrivateAddress;
  }
}
