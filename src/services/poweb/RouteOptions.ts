import { UnboundKeyPair } from '@relaycorp/relaynet-core';

export default interface RouteOptions {
  readonly keyPairRetriever: () => Promise<UnboundKeyPair>;
}
