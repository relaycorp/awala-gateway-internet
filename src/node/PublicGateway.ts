import { Certificate, Gateway, getIdFromIdentityKey } from '@relaycorp/relaynet-core';

import { PublicGatewayChannel } from './PublicGatewayChannel';

export class PublicGateway extends Gateway {
  public async getChannel(
    pda: Certificate,
    privateGatewayPublicKey: CryptoKey,
  ): Promise<PublicGatewayChannel> {
    const privateGatewayId = await getIdFromIdentityKey(privateGatewayPublicKey);
    return new PublicGatewayChannel(
      this.identityPrivateKey,
      pda,
      privateGatewayId,
      privateGatewayPublicKey,
      this.keyStores,
    );
  }
}
