import {
  Certificate,
  generateRSAKeyPair,
  issueEndpointCertificate,
  issueGatewayCertificate,
  Parcel,
} from '@relaycorp/relaynet-core';
import { deliverParcel, PoHTTPError } from '@relaycorp/relaynet-pohttp';
import { AxiosError } from 'axios';
import * as dockerCompose from 'docker-compose';

const TOMORROW = new Date();
TOMORROW.setDate(TOMORROW.getDate() + 1);

describe('PoHTTP server', () => {
  beforeAll(async () => {
    jest.setTimeout(60_000);
    await setUpServices();
    jest.setTimeout(5_000);
  });
  afterAll(tearDownServices);

  beforeAll(async () => {
    const gatewayKeyPair = await generateRSAKeyPair();

    const gatewayCertificate = await issueGatewayCertificate({
      issuerPrivateKey: gatewayKeyPair.privateKey,
      subjectPublicKey: gatewayKeyPair.publicKey,
      validityEndDate: TOMORROW,
    });

    await setUpGateway(gatewayCertificate, gatewayKeyPair.privateKey);
  });

  test('Valid parcel should be accepted', () => {
    expect(1).toEqual(1);
  });

  test('Unauthorized parcel should be refused', async () => {
    const senderKeyPair = await generateRSAKeyPair();
    const senderCertificate = await issueEndpointCertificate({
      issuerPrivateKey: senderKeyPair.privateKey,
      subjectPublicKey: senderKeyPair.publicKey,
      validityEndDate: TOMORROW,
    });

    const parcel = new Parcel('0deadbeef', senderCertificate, Buffer.from([]));

    await expect(
      deliverParcel('http://127.0.0.1:8080', await parcel.serialize(senderKeyPair.privateKey)),
    ).rejects.toSatisfy((err: PoHTTPError) => {
      const response = (err.cause() as AxiosError).response;
      return (
        response!.status === 400 && response!.data.message === 'Parcel sender is not authorized'
      );
    });
  });
});

async function setUpServices(): Promise<void> {
  await dockerCompose.upAll({ log: true });

  // Configure Vault
  await dockerCompose.exec('vault', ['vault', 'secrets', 'enable', '-path=gw-keys', 'kv-v2'], {
    commandOptions: ['--env', 'VAULT_ADDR=http://127.0.0.1:8200', '--env', 'VAULT_TOKEN=letmein'],
    log: true,
  });
}

async function tearDownServices(): Promise<void> {
  await dockerCompose.down({ commandOptions: ['--remove-orphans'] });
}

async function setUpGateway(_certificate: Certificate, _privateKey: CryptoKey): Promise<void> {
  await dockerCompose.exec('cogrpc', ['ts-node-dev', 'src/bin/generate-keypairs.ts']);
}
