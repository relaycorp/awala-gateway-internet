import { Certificate, generateRSAKeyPair, issueGatewayCertificate } from '@relaycorp/relaynet-core';
import * as dockerCompose from 'docker-compose';
import { dirname } from 'path';

const DOCKER_COMPOSE_CWD = dirname(dirname(__dirname));

describe('PoHTTP server', () => {
  beforeAll(startServices);
  afterAll(tearDownServices);

  beforeAll(async () => {
    const gatewayKeyPair = await generateRSAKeyPair();

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const gatewayCertificate = await issueGatewayCertificate({
      issuerPrivateKey: gatewayKeyPair.privateKey,
      subjectPublicKey: gatewayKeyPair.publicKey,
      validityEndDate: tomorrow,
    });

    await setUpGateway(gatewayCertificate, gatewayKeyPair.privateKey);
  });

  test('Valid parcel should be accepted', () => {
    expect(1).toEqual(1);
  });
});

async function startServices(): Promise<void> {
  await dockerCompose.upAll({ cwd: DOCKER_COMPOSE_CWD, log: true });
}

async function tearDownServices(): Promise<void> {
  await dockerCompose.down({ cwd: DOCKER_COMPOSE_CWD });
}

async function setUpGateway(_certificate: Certificate, _privateKey: CryptoKey): Promise<void> {
  // tslint:disable-next-line:no-console
  console.log('Set up');
}
