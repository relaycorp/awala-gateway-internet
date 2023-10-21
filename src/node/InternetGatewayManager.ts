import { GatewayManager, KeyStoreSet } from '@relaycorp/relaynet-core';
import { MongoCertificateStore, MongoPublicKeyStore } from '@relaycorp/awala-keystore-mongodb';
import { Connection } from 'mongoose';

import { initPrivateKeyStore } from '../backingServices/keystore';
import { InternetGatewayError } from '../errors';
import { Config, ConfigKey } from '../utilities/config';
import { InternetGateway } from './InternetGateway';

export class InternetGatewayManager extends GatewayManager<undefined> {
  public static async init(mongoConnection: Connection): Promise<InternetGatewayManager> {
    const certificateStore = new MongoCertificateStore(mongoConnection);
    const publicKeyStore = new MongoPublicKeyStore(mongoConnection);
    const privateKeyStore = initPrivateKeyStore(mongoConnection);
    return new InternetGatewayManager(mongoConnection, {
      certificateStore,
      privateKeyStore,
      publicKeyStore,
    });
  }

  protected readonly defaultNodeConstructor = InternetGateway;

  constructor(
    protected connection: Connection,
    keyStores: KeyStoreSet,
  ) {
    super(keyStores);
  }

  public async getCurrent(): Promise<InternetGateway> {
    const config = new Config(this.connection);
    const id = await config.get(ConfigKey.CURRENT_ID);
    if (!id) {
      throw new InternetGatewayError('Current id is unset');
    }
    const gateway = (await this.get(id)) as InternetGateway;
    if (!gateway) {
      throw new InternetGatewayError(`Internet gateway does not exist (id: ${id})`);
    }
    return gateway;
  }
}
