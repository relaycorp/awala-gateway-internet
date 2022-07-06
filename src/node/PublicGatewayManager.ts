import { GatewayManager, KeyStoreSet } from '@relaycorp/relaynet-core';
import { Connection } from 'mongoose';

import { initPrivateKeyStore } from '../backingServices/keystore';
import { PublicGatewayError } from '../errors';
import { MongoCertificateStore } from '../keystores/MongoCertificateStore';
import { MongoPublicKeyStore } from '../keystores/MongoPublicKeyStore';
import { Config, ConfigKey } from '../utilities/config';
import { PublicGateway } from './PublicGateway';

export class PublicGatewayManager extends GatewayManager<PublicGateway> {
  public static async init(mongoConnection: Connection): Promise<PublicGatewayManager> {
    const certificateStore = new MongoCertificateStore(mongoConnection);
    const publicKeyStore = new MongoPublicKeyStore(mongoConnection);
    const privateKeyStore = await initPrivateKeyStore(mongoConnection);
    return new PublicGatewayManager(mongoConnection, {
      certificateStore,
      privateKeyStore,
      publicKeyStore,
    });
  }

  protected readonly defaultNodeConstructor = PublicGateway;

  constructor(protected connection: Connection, keyStores: KeyStoreSet) {
    super(keyStores);
  }

  public async getCurrent(): Promise<PublicGateway> {
    const config = new Config(this.connection);
    const privateAddress = await config.get(ConfigKey.CURRENT_PRIVATE_ADDRESS);
    if (!privateAddress) {
      throw new PublicGatewayError('Current private address is unset');
    }
    const gateway = await this.get(privateAddress);
    if (!gateway) {
      throw new PublicGatewayError(
        `Public gateway does not exist (private address: ${privateAddress})`,
      );
    }
    return gateway;
  }
}
