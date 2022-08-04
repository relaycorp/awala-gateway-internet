import { Cargo, CargoMessageSet, SessionEnvelopedData, SessionKey } from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';

import { ExternalPdaChain } from '../../testUtils/pki';
import { GW_INTERNET_ADDRESS } from './constants';

export async function encapsulateMessagesInCargo(
  messages: readonly ArrayBuffer[],
  gwPDAChain: ExternalPdaChain,
  publicGatewaySessionKey: SessionKey,
): Promise<Buffer> {
  const messageSet = new CargoMessageSet(messages);
  const { envelopedData } = await SessionEnvelopedData.encrypt(
    messageSet.serialize(),
    publicGatewaySessionKey,
  );
  const cargo = new Cargo(
    {
      id: await gwPDAChain.publicGatewayCert.calculateSubjectId(),
      internetAddress: GW_INTERNET_ADDRESS,
    },
    gwPDAChain.privateGatewayCert,
    Buffer.from(envelopedData.serialize()),
  );
  return Buffer.from(await cargo.serialize(gwPDAChain.privateGatewayPrivateKey));
}

export async function extractMessagesFromCargo(
  cargoSerialized: Buffer,
  recipientId: string,
  recipientSessionPrivateKey: CryptoKey,
): Promise<readonly ArrayBuffer[]> {
  const cargo = await Cargo.deserialize(bufferToArray(cargoSerialized));
  expect(cargo.recipient.id).toEqual(recipientId);
  const { payload: cargoMessageSet } = await cargo.unwrapPayload(recipientSessionPrivateKey);
  return Array.from(cargoMessageSet.messages);
}
