import { getPrivateAddressFromIdentityKey, MockKeyStoreSet } from '@relaycorp/relaynet-core';
import {
  CDACertPath,
  generateCDACertificationPath,
  generateIdentityKeyPairSet,
  NodeKeyPairSet,
} from '@relaycorp/relaynet-testing';

import { PublicGatewayChannel } from './PublicGatewayChannel';

let keyPairSet: NodeKeyPairSet;
let cdaChain: CDACertPath;
beforeAll(async () => {
  keyPairSet = await generateIdentityKeyPairSet();
  cdaChain = await generateCDACertificationPath(keyPairSet);
});

describe('getOutboundRAMFAddress', () => {
  test('Address should be that of private gateway', async () => {
    const peerPrivateAddress = await getPrivateAddressFromIdentityKey(
      keyPairSet.privateGateway.publicKey,
    );
    const channel = new PublicGatewayChannel(
      keyPairSet.publicGateway.privateKey,
      cdaChain.publicGateway,
      peerPrivateAddress,
      keyPairSet.privateGateway.publicKey,
      new MockKeyStoreSet(),
      {},
    );

    expect(channel.getOutboundRAMFAddress()).toEqual(peerPrivateAddress);
  });
});
