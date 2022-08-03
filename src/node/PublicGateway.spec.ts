import {
  Cargo,
  derSerializePublicKey,
  MockKeyStoreSet,
  SessionKeyPair,
} from '@relaycorp/relaynet-core';
import {
  CDACertPath,
  generateCDACertificationPath,
  generateIdentityKeyPairSet,
  NodeKeyPairSet,
} from '@relaycorp/relaynet-testing';
import bufferToArray from 'buffer-to-arraybuffer';
import { addMinutes } from 'date-fns';

import { arrayToAsyncIterable, asyncIterableToArray } from '../testUtils/iter';
import { PublicGateway } from './PublicGateway';

let keyPairSet: NodeKeyPairSet;
let cdaChain: CDACertPath;
beforeAll(async () => {
  keyPairSet = await generateIdentityKeyPairSet();
  cdaChain = await generateCDACertificationPath(keyPairSet);
});

const KEY_STORES = new MockKeyStoreSet();
beforeEach(async () => {
  KEY_STORES.clear();

  const peerSessionKeyPair = await SessionKeyPair.generate();
  await KEY_STORES.publicKeyStore.saveSessionKey(
    peerSessionKeyPair.sessionKey,
    await cdaChain.privateGateway.calculateSubjectId(),
    new Date(),
  );
});

let publicGateway: PublicGateway;
beforeAll(async () => {
  publicGateway = new PublicGateway(
    await cdaChain.publicGateway.calculateSubjectId(),
    keyPairSet.publicGateway.privateKey,
    KEY_STORES,
    {},
  );
});

describe('getChannel', () => {
  test('Public gateway private key should be passed on', async () => {
    const channel = await publicGateway.getChannel(
      cdaChain.publicGateway,
      keyPairSet.privateGateway.publicKey,
    );

    // We can't just read the private key, so we have to use it:
    const dummyCargoMessage = { message: Buffer.from([]), expiryDate: addMinutes(new Date(), 1) };
    const [cargoSerialized] = await asyncIterableToArray(
      channel.generateCargoes(arrayToAsyncIterable([dummyCargoMessage])),
    );
    const cargo = await Cargo.deserialize(bufferToArray(cargoSerialized));
    await expect(cargo.senderCertificate.calculateSubjectId()).resolves.toEqual(publicGateway.id);
  });

  test('PDA for private gateway should be passed on', async () => {
    const channel = await publicGateway.getChannel(
      cdaChain.publicGateway,
      keyPairSet.privateGateway.publicKey,
    );

    expect(cdaChain.publicGateway.isEqual(channel.nodeDeliveryAuth)).toBeTrue();
  });

  test('Private gateway private address should be set', async () => {
    const channel = await publicGateway.getChannel(
      cdaChain.publicGateway,
      keyPairSet.privateGateway.publicKey,
    );

    expect(channel.peerId).toEqual(await cdaChain.privateGateway.calculateSubjectId());
  });

  test('Private gateway public key should be set', async () => {
    const channel = await publicGateway.getChannel(
      cdaChain.publicGateway,
      keyPairSet.privateGateway.publicKey,
    );

    await expect(derSerializePublicKey(channel.peerPublicKey)).resolves.toEqual(
      await derSerializePublicKey(keyPairSet.privateGateway.publicKey),
    );
  });
});
