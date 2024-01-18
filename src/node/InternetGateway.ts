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

  /**
   * Generate the initial session key if it doesn't exist yet.
   * @returns Whether the initial session key was created.
   */
  public async makeInitialSessionKeyIfMissing(): Promise<boolean> {
    const existingKey = await this.keyStores.privateKeyStore.retrieveUnboundSessionPublicKey(
      this.id,
    );
    if (existingKey !== null) {
      return false;
    }

    await this.generateSessionKey();
    return true;
  }
}
