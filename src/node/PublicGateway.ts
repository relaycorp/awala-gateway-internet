import { Certificate, Gateway, getPrivateAddressFromIdentityKey } from '@relaycorp/relaynet-core';

import { PublicGatewayChannel } from './PublicGatewayChannel';

export class PublicGateway extends Gateway {
  public async getChannel(
    pda: Certificate,
    privateGatewayPublicKey: CryptoKey,
  ): Promise<PublicGatewayChannel> {
    const privateGatewayPrivateAddress = await getPrivateAddressFromIdentityKey(
      privateGatewayPublicKey,
    );
    return new PublicGatewayChannel(
      this.identityPrivateKey,
      pda,
      privateGatewayPrivateAddress,
      privateGatewayPublicKey,
      this.keyStores,
    );
  }
}
