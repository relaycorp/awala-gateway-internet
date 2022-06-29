import {
  CertificationPath,
  GatewayManager,
  issueGatewayCertificate,
  KeyStoreSet,
} from '@relaycorp/relaynet-core';
import { addDays } from 'date-fns';
import { Connection } from 'mongoose';

import { initPrivateKeyStore } from '../backingServices/keystore';
import { PublicGatewayError } from '../errors';
import { MongoCertificateStore } from '../keystores/MongoCertificateStore';
import { MongoPublicKeyStore } from '../keystores/MongoPublicKeyStore';
import { CERTIFICATE_TTL_DAYS } from '../pki';
import { Config, ConfigKey } from '../utilities/config';
import { PublicGateway } from './PublicGateway';

export class PublicGatewayManager extends GatewayManager<PublicGateway> {
  public static async init(mongoConnection: Connection): Promise<PublicGatewayManager> {
    const certificateStore = new MongoCertificateStore(mongoConnection);
    const publicKeyStore = new MongoPublicKeyStore(mongoConnection);
    const privateKeyStore = await initPrivateKeyStore();
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

  public async generate(): Promise<string> {
    const { privateAddress, privateKey, publicKey } =
      await this.keyStores.privateKeyStore.generateIdentityKeyPair();

    const gatewayCertificate = await issueGatewayCertificate({
      issuerPrivateKey: privateKey,
      subjectPublicKey: publicKey,
      validityEndDate: addDays(new Date(), CERTIFICATE_TTL_DAYS),
    });
    await this.keyStores.certificateStore.save(
      new CertificationPath(gatewayCertificate, []),
      privateAddress,
    );

    const config = new Config(this.connection);
    await config.set(ConfigKey.CURRENT_PRIVATE_ADDRESS, privateAddress);

    return privateAddress;
  }

  public async getCurrentPrivateAddress(): Promise<string | null> {
    const config = new Config(this.connection);
    return config.get(ConfigKey.CURRENT_PRIVATE_ADDRESS);
  }

  public async getCurrent(): Promise<PublicGateway> {
    const privateAddress = await this.getCurrentPrivateAddress();
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
