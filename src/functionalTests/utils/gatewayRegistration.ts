import {
  generateRSAKeyPair,
  issueDeliveryAuthorization,
  issueEndpointCertificate,
  PrivateNodeRegistration,
  PrivateNodeRegistrationRequest,
  SessionKey,
} from '@relaycorp/relaynet-core';
import { PoWebClient } from '@relaycorp/relaynet-poweb';

import { ExternalPdaChain } from '../../testUtils/pki';
import { GW_POWEB_HOST_PORT } from './constants';

export interface PrivateGatewayRegistration {
  readonly pdaChain: ExternalPdaChain;
  readonly publicGatewaySessionKey: SessionKey;
}

export async function createAndRegisterPrivateGateway(): Promise<PrivateGatewayRegistration> {
  const privateGatewayKeyPair = await generateRSAKeyPair();
  const {
    privateNodeCertificate: privateGatewayCertificate,
    gatewayCertificate: publicGatewayCert,
    sessionKey: publicGatewaySessionKey,
  } = await registerPrivateGateway(
    privateGatewayKeyPair,
    PoWebClient.initLocal(GW_POWEB_HOST_PORT),
  );

  const peerEndpointKeyPair = await generateRSAKeyPair();
  const peerEndpointCertificate = await issueEndpointCertificate({
    issuerCertificate: privateGatewayCertificate,
    issuerPrivateKey: privateGatewayKeyPair.privateKey,
    subjectPublicKey: peerEndpointKeyPair.publicKey,
    validityEndDate: privateGatewayCertificate.expiryDate,
  });

  const pdaGranteeKeyPair = await generateRSAKeyPair();
  const pda = await issueDeliveryAuthorization({
    issuerCertificate: peerEndpointCertificate,
    issuerPrivateKey: peerEndpointKeyPair.privateKey,
    subjectPublicKey: pdaGranteeKeyPair.publicKey,
    validityEndDate: peerEndpointCertificate.expiryDate,
  });

  const pdaChain = {
    pdaCert: pda,
    pdaGranteePrivateKey: pdaGranteeKeyPair.privateKey,
    peerEndpointCert: peerEndpointCertificate,
    peerEndpointPrivateKey: peerEndpointKeyPair.privateKey,
    privateGatewayCert: privateGatewayCertificate,
    privateGatewayPrivateKey: privateGatewayKeyPair.privateKey,
    publicGatewayCert,
  };
  return { pdaChain, publicGatewaySessionKey: publicGatewaySessionKey!! };
}

export async function registerPrivateGateway(
  privateGatewayKeyPair: CryptoKeyPair,
  client: PoWebClient,
): Promise<PrivateNodeRegistration> {
  const authorizationSerialized = await client.preRegisterNode(privateGatewayKeyPair.publicKey);
  const request = new PrivateNodeRegistrationRequest(
    privateGatewayKeyPair.publicKey,
    authorizationSerialized,
  );
  const requestSerialized = await request.serialize(privateGatewayKeyPair.privateKey);
  return client.registerNode(requestSerialized);
}
