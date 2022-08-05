import {
  Certificate,
  CertificationPath,
  getIdFromIdentityKey,
  issueDeliveryAuthorization,
  Parcel,
  PublicNodeConnectionParams,
  ServiceMessage,
  SessionEnvelopedData,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { get as httpGet } from 'http';

import { ExternalPdaChain } from '../../testUtils/pki';
import { GW_INTERNET_ADDRESS, PONG_LOCAL_URL } from './constants';

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

export async function makePingParcel(
  pingId: string,
  gwPDAChain: ExternalPdaChain,
): Promise<{
  readonly parcelId: string;
  readonly parcelSerialized: ArrayBuffer;
  readonly sessionKey: CryptoKey;
}> {
  const pongConnectionParams = await getPongConnectionParams();
  const pongEndpointPda = await issueDeliveryAuthorization({
    issuerCertificate: gwPDAChain.peerEndpointCert,
    issuerPrivateKey: gwPDAChain.peerEndpointPrivateKey,
    subjectPublicKey: pongConnectionParams.identityKey,
    validityEndDate: gwPDAChain.peerEndpointCert.expiryDate,
  });
  const pingSerialized = serializePing(pingId, pongEndpointPda, [
    gwPDAChain.peerEndpointCert,
    gwPDAChain.privateGatewayCert,
  ]);

  const serviceMessage = new ServiceMessage('application/vnd.awala.ping-v1.ping', pingSerialized);
  const pingEncryption = await SessionEnvelopedData.encrypt(
    serviceMessage.serialize(),
    pongConnectionParams.sessionKey,
  );
  const parcel = new Parcel(
    {
      id: await getIdFromIdentityKey(pongConnectionParams.identityKey),
      internetAddress: pongConnectionParams.internetAddress,
    },
    gwPDAChain.peerEndpointCert,
    Buffer.from(pingEncryption.envelopedData.serialize()),
  );
  return {
    parcelId: parcel.id,
    parcelSerialized: await parcel.serialize(gwPDAChain.peerEndpointPrivateKey),
    sessionKey: pingEncryption.dhPrivateKey,
  };
}

export async function extractPong(parcel: Parcel, sessionKey: CryptoKey): Promise<string> {
  const unwrapResult = await parcel.unwrapPayload(sessionKey);
  const serviceMessageContent = unwrapResult.payload.content;
  return serviceMessageContent.toString();
}

async function getPongConnectionParams(): Promise<PublicNodeConnectionParams> {
  const connectionParamsSerialization = await downloadFileFromURL(
    `${PONG_LOCAL_URL}/connection-params.der`,
  );
  return PublicNodeConnectionParams.deserialize(bufferToArray(connectionParamsSerialization));
}

async function downloadFileFromURL(url: string): Promise<Buffer> {
  // tslint:disable-next-line:readonly-array
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    httpGet(url, { timeout: 2_000 }, (response) => {
      if (response.statusCode !== 200) {
        return reject(new Error(`Failed to download ${url} (HTTP ${response.statusCode})`));
      }

      response.on('error', reject);

      response.on('data', (chunk) => chunks.push(chunk));

      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}
