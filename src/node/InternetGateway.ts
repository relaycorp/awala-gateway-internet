import { Certificate, Gateway, getIdFromIdentityKey } from '@relaycorp/relaynet-core';

import { InternetGatewayChannel } from './InternetGatewayChannel';

export class InternetGateway extends Gateway {
  public async getChannel(
    pda: Certificate,
    privateGatewayPublicKey: CryptoKey,
  ): Promise<InternetGatewayChannel> {
    const privateGatewayId = await getIdFromIdentityKey(privateGatewayPublicKey);
    return new InternetGatewayChannel(
      this.identityPrivateKey,
      pda,
      privateGatewayId,
      privateGatewayPublicKey,
      this.keyStores,
    );
  }
}
