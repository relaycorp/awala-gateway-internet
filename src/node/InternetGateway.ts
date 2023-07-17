import {
  Certificate,
  CertificationPath,
  Gateway,
  getIdFromIdentityKey,
} from '@relaycorp/relaynet-core';

import { InternetGatewayChannel } from './InternetGatewayChannel';

export class InternetGateway extends Gateway<undefined> {
  protected readonly channelConstructor = InternetGatewayChannel;

  public async getChannelFromCda(
    cda: Certificate,
    privateGatewayPublicKey: CryptoKey,
  ): Promise<InternetGatewayChannel> {
    const privateGatewayId = await getIdFromIdentityKey(privateGatewayPublicKey);
    const peer = {
      id: privateGatewayId,
      identityPublicKey: privateGatewayPublicKey,
      internetAddress: undefined,
    };
    return new InternetGatewayChannel(this, peer, new CertificationPath(cda, []), this.keyStores);
  }
}
