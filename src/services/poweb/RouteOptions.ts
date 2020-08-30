import { PrivateKeyStore } from '@relaycorp/relaynet-core';

export default interface RouteOptions {
  readonly gatewayKeyId: Buffer;
  readonly privateKeyStore: PrivateKeyStore;
}
