import {
  derSerializePublicKey,
  generateRSAKeyPair,
  PrivateNodeRegistrationRequest,
} from '@relaycorp/relaynet-core';
import { PoWebClient } from '@relaycorp/relaynet-poweb';

import { configureServices, GW_POWEB_LOCAL_PORT } from './services';
import { getPublicGatewayCertificate } from './utils';

configureServices(['poweb']);

describe('PoWeb server', () => {
  describe('Node registration', () => {
    test('Valid registration requests should be accepted', async () => {
      const client = PoWebClient.initLocal(GW_POWEB_LOCAL_PORT);
      const privateGatewayKeyPair = await generateRSAKeyPair();

      const authorizationSerialized = await client.preRegisterNode(privateGatewayKeyPair.publicKey);
      const registrationRequest = new PrivateNodeRegistrationRequest(
        privateGatewayKeyPair.publicKey,
        authorizationSerialized,
      );
      const registration = await client.registerNode(
        await registrationRequest.serialize(privateGatewayKeyPair.privateKey),
      );

      await expect(
        derSerializePublicKey(await registration.privateNodeCertificate.getPublicKey()),
      ).resolves.toEqual(derSerializePublicKey(privateGatewayKeyPair.publicKey));

      const actualPublicGatewayCertificate = await getPublicGatewayCertificate();
      expect(actualPublicGatewayCertificate.isEqual(registration.gatewayCertificate));

      await expect(
        registration.privateNodeCertificate.getCertificationPath(
          [],
          [registration.gatewayCertificate],
        ),
      ).resolves.toHaveLength(2);
    });

    test.todo('Registration request for different key should be refused');
  });
});
