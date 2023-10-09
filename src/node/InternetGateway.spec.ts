import { Cargo, MockKeyStoreSet, SessionKeyPair } from '@relaycorp/relaynet-core';
import {
  CDACertPath,
  generateCDACertificationPath,
  generateIdentityKeyPairSet,
  NodeKeyPairSet,
} from '@relaycorp/relaynet-testing';
import bufferToArray from 'buffer-to-arraybuffer';
import { addMinutes } from 'date-fns';

import { arrayToAsyncIterable } from '../testUtils/iter';
import { InternetGateway } from './InternetGateway';
import { collect } from 'streaming-iterables';

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

let internetGateway: InternetGateway;
beforeAll(async () => {
  internetGateway = new InternetGateway(
    await cdaChain.internetGateway.calculateSubjectId(),
    keyPairSet.internetGateway,
    KEY_STORES,
    {},
  );
});

describe('getChannelFromCda', () => {
  test('Internet gateway private key should be passed on', async () => {
    const channel = await internetGateway.getChannelFromCda(
      cdaChain.internetGateway,
      keyPairSet.privateGateway.publicKey,
    );

    // We can't just read the private key, so we have to use it:
    const dummyCargoMessage = { message: Buffer.from([]), expiryDate: addMinutes(new Date(), 1) };
    const [cargoSerialized] = await collect(
      channel.generateCargoes(arrayToAsyncIterable([dummyCargoMessage])),
    );
    const cargo = await Cargo.deserialize(bufferToArray(cargoSerialized));
    await expect(cargo.senderCertificate.calculateSubjectId()).resolves.toEqual(internetGateway.id);
  });

  test('CDA for private gateway should be passed on', async () => {
    const channel = await internetGateway.getChannelFromCda(
      cdaChain.internetGateway,
      keyPairSet.privateGateway.publicKey,
    );

    expect(cdaChain.internetGateway.isEqual(channel.deliveryAuthPath.leafCertificate)).toBeTrue();
    expect(channel.deliveryAuthPath.certificateAuthorities).toBeEmpty();
  });

  test('Private gateway id should be set', async () => {
    const channel = await internetGateway.getChannelFromCda(
      cdaChain.internetGateway,
      keyPairSet.privateGateway.publicKey,
    );

    expect(channel.peer.id).toEqual(await cdaChain.privateGateway.calculateSubjectId());
  });

  test('Private gateway public key should be set', async () => {
    const channel = await internetGateway.getChannelFromCda(
      cdaChain.internetGateway,
      keyPairSet.privateGateway.publicKey,
    );

    expect(channel.peer.identityPublicKey).toBe(keyPairSet.privateGateway.publicKey);
  });

  test('Private gateway Internet gateway should be unset', async () => {
    const channel = await internetGateway.getChannelFromCda(
      cdaChain.internetGateway,
      keyPairSet.privateGateway.publicKey,
    );

    expect(channel.peer.internetAddress).toBeUndefined();
  });
});
