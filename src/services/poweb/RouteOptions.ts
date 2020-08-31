import { Certificate } from '@relaycorp/relaynet-core';

export default interface RouteOptions {
  readonly publicGatewayPrivateKey: CryptoKey;
  readonly publicGatewayCertificate: Certificate;
}
