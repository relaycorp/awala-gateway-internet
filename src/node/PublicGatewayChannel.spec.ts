import { getIdFromIdentityKey, MockKeyStoreSet, Recipient } from '@relaycorp/relaynet-core';
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

describe('getOutboundRAMFRecipient', () => {
  test('Address should be that of private gateway', async () => {
    const peerId = await getIdFromIdentityKey(keyPairSet.privateGateway.publicKey);
    const channel = new PublicGatewayChannel(
      keyPairSet.publicGateway.privateKey,
      cdaChain.publicGateway,
      peerId,
      keyPairSet.privateGateway.publicKey,
      new MockKeyStoreSet(),
      {},
    );

    await expect(channel.getOutboundRAMFRecipient()).resolves.toEqual<Recipient>({ id: peerId });
  });
});
