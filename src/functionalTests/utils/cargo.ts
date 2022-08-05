import {
  Cargo,
  CargoMessageSet,
  SessionEnvelopedData,
  SessionKey,
  CargoMessageSetItem,
  Certificate,
  PrivateKeyStore,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';

import { ExternalPdaChain } from '../../testUtils/pki';
import { GW_INTERNET_ADDRESS } from './constants';

export async function encapsulateMessagesInCargo(
  messages: readonly ArrayBuffer[],
  gwPDAChain: ExternalPdaChain,
  publicGatewaySessionKey: SessionKey,
  privateGatewayKeyStore: PrivateKeyStore,
): Promise<Buffer> {
  const messageSet = new CargoMessageSet(messages);
  const { envelopedData, dhKeyId, dhPrivateKey } = await SessionEnvelopedData.encrypt(
    messageSet.serialize(),
    publicGatewaySessionKey,
  );

  const publicGatewayId = await gwPDAChain.publicGatewayCert.calculateSubjectId();
  await privateGatewayKeyStore.saveSessionKey(
    dhPrivateKey,
    Buffer.from(dhKeyId),
    await gwPDAChain.privateGatewayCert.calculateSubjectId(),
    publicGatewayId,
  );

  const cargo = new Cargo(
    { id: publicGatewayId, internetAddress: GW_INTERNET_ADDRESS },
    gwPDAChain.privateGatewayCert,
    Buffer.from(envelopedData.serialize()),
  );
  return Buffer.from(await cargo.serialize(gwPDAChain.privateGatewayPrivateKey));
}

export async function extractMessagesFromCargo(
  cargoSerialized: Buffer,
  recipientCertificate: Certificate,
  recipientSessionPrivateKey: CryptoKey | PrivateKeyStore,
): Promise<readonly CargoMessageSetItem[]> {
  const cargo = await Cargo.deserialize(bufferToArray(cargoSerialized));
  await cargo.validate([recipientCertificate]);
  const { payload: cargoMessageSet } = await cargo.unwrapPayload(recipientSessionPrivateKey);
  return Promise.all(cargoMessageSet.messages.map(CargoMessageSet.deserializeItem));
}
