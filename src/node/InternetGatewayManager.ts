import {
  CertificationPath,
  GatewayManager,
  issueGatewayCertificate,
  KeyStoreSet,
} from '@relaycorp/relaynet-core';
import { MongoCertificateStore, MongoPublicKeyStore } from '@relaycorp/awala-keystore-mongodb';
import { addDays } from 'date-fns';
import { Connection } from 'mongoose';

import { initPrivateKeyStore } from '../backingServices/keystore';
import { InternetGatewayError } from '../errors';
import { Config, ConfigKey } from '../utilities/config';
import { InternetGateway } from './InternetGateway';
import { CERTIFICATE_TTL_DAYS } from '../pki';

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

  public async getOrCreateCurrent(): Promise<InternetGateway> {
    let id = await this.getCurrentId();
    if (!id) {
      id = await this.create();
      const config = new Config(this.connection);
      await config.set(ConfigKey.CURRENT_ID, id);
    }
    return this.getOrThrow(id);
  }

  public async getCurrent(): Promise<InternetGateway> {
    const id = await this.getCurrentId();
    if (!id) {
      throw new InternetGatewayError('Current id is unset');
    }
    return this.getOrThrow(id);
  }

  protected async getCurrentId(): Promise<string | null> {
    const config = new Config(this.connection);
    return config.get(ConfigKey.CURRENT_ID);
  }

  protected async getOrThrow(id: string): Promise<InternetGateway> {
    const gateway = (await this.get(id)) as InternetGateway;
    if (!gateway) {
      throw new InternetGatewayError(`Internet gateway does not exist (id: ${id})`);
    }
    return gateway;
  }

  protected async create(): Promise<string> {
    const { id, privateKey, publicKey } =
      await this.keyStores.privateKeyStore.generateIdentityKeyPair();

    const gatewayCertificate = await issueGatewayCertificate({
      issuerPrivateKey: privateKey,
      subjectPublicKey: publicKey,
      validityEndDate: addDays(new Date(), CERTIFICATE_TTL_DAYS),
    });
    await this.keyStores.certificateStore.save(new CertificationPath(gatewayCertificate, []), id);

    return id;
  }
}
