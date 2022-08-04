import { Certificate, CertificationPath, Parcel } from '@relaycorp/relaynet-core';
import { GW_INTERNET_ADDRESS } from './services';

export function serializePing(
  id: string,
  pda: Certificate,
  pdaCAs: readonly Certificate[],
): Buffer {
  const path = new CertificationPath(pda, pdaCAs);
  const pdaPathSerialized = Buffer.from(path.serialize()).toString('base64');
  const pingSerialized = JSON.stringify({
    id,
    endpoint_internet_address: GW_INTERNET_ADDRESS,
    pda_path: pdaPathSerialized,
  });
  return Buffer.from(pingSerialized);
}

export async function deserializePong(
  parcelSerialized: ArrayBuffer,
  sessionKey: CryptoKey,
): Promise<string> {
  const parcel = await Parcel.deserialize(parcelSerialized);
  const unwrapResult = await parcel.unwrapPayload(sessionKey);
  const serviceMessageContent = unwrapResult.payload.content;
  return serviceMessageContent.toString();
}
