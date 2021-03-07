import { CogRPCClient } from '@relaycorp/cogrpc';
import { VaultPrivateKeyStore } from '@relaycorp/keystore-vault';
import {
  Cargo,
  CargoMessageSet,
  Certificate,
  issueDeliveryAuthorization,
  Parcel,
  ParcelCollectionAck,
  ServiceMessage,
  SessionEnvelopedData,
  SessionlessEnvelopedData,
  Signer,
} from '@relaycorp/relaynet-core';
import { PoWebClient, StreamingMode } from '@relaycorp/relaynet-poweb';
import bufferToArray from 'buffer-to-arraybuffer';
import { get as getEnvVar } from 'env-var';
import pipe from 'it-pipe';
import uuid from 'uuid-random';

import {
  asyncIterableToArray,
  ExternalPdaChain,
  generateCCA,
  generateCDAChain,
  iterableTake,
} from '../_test_utils';
import {
  GW_COGRPC_URL,
  GW_POWEB_LOCAL_PORT,
  GW_PUBLIC_ADDRESS_URL,
  PONG_ENDPOINT_ADDRESS,
} from './services';
import { arrayToIterable, generatePdaChain, IS_GITHUB, sleep } from './utils';

test('Sending pings via PoWeb and receiving pongs via PoHTTP', async () => {
  const powebClient = PoWebClient.initLocal(GW_POWEB_LOCAL_PORT);
  const gwPDAChain = await generatePdaChain();
  const privateGatewaySigner = new Signer(
    gwPDAChain.privateGatewayCert,
    gwPDAChain.privateGatewayPrivateKey,
  );

  const pongEndpointSessionCertificate = await getPongEndpointKeyPairs();
  const pingId = uuid();
  const pingParcelData = await makePingParcel(
    pingId,
    pongEndpointSessionCertificate.identityCert,
    pongEndpointSessionCertificate.sessionCert,
    gwPDAChain,
  );

  // Deliver the ping message
  await powebClient.deliverParcel(pingParcelData.parcelSerialized, privateGatewaySigner);

  // Collect the pong message once it's been received
  const incomingParcels = await pipe(
    powebClient.collectParcels([privateGatewaySigner], StreamingMode.KEEP_ALIVE),
    async function* (collections): AsyncIterable<ArrayBuffer> {
      for await (const collection of collections) {
        yield collection.parcelSerialized;
        await collection.ack();
      }
    },
    iterableTake(1),
    asyncIterableToArray,
  );
  expect(incomingParcels).toHaveLength(1);

  await expect(deserializePong(incomingParcels[0], pingParcelData.sessionKey)).resolves.toEqual(
    pingId,
  );
});

test('Sending pings via CogRPC and receiving pongs via PoHTTP', async () => {
  const pongEndpointSessionCertificate = await getPongEndpointKeyPairs();
  const pdaChain = await generatePdaChain();

  const pingId = uuid();
  const pingParcelData = await makePingParcel(
    pingId,
    pongEndpointSessionCertificate.identityCert,
    pongEndpointSessionCertificate.sessionCert,
    pdaChain,
  );

  const cogRPCClient = await CogRPCClient.init(GW_COGRPC_URL);
  try {
    // Deliver the ping message encapsulated in a cargo
    const cargoSerialized = await encapsulateParcelsInCargo(
      [pingParcelData.parcelSerialized],
      pdaChain,
    );
    await asyncIterableToArray(
      cogRPCClient.deliverCargo(
        arrayToIterable([{ localId: 'random-delivery-id', cargo: cargoSerialized }]),
      ),
    );

    await sleep(IS_GITHUB ? 4 : 2);

    // Collect the pong message encapsulated in a cargo
    const cdaChain = await generateCDAChain(pdaChain);
    const ccaSerialized = await generateCCA(
      GW_PUBLIC_ADDRESS_URL,
      cdaChain,
      pdaChain.publicGatewayCert,
      pdaChain.privateGatewayPrivateKey,
    );
    const collectedCargoes = await asyncIterableToArray(cogRPCClient.collectCargo(ccaSerialized));
    expect(collectedCargoes).toHaveLength(1);
    const collectedMessages = await extractMessagesFromCargo(collectedCargoes[0], pdaChain);
    expect(collectedMessages).toHaveLength(2);
    expect(ParcelCollectionAck.deserialize(collectedMessages[0])).toHaveProperty(
      'parcelId',
      pingParcelData.parcelId,
    );
    await expect(deserializePong(collectedMessages[1], pingParcelData.sessionKey)).resolves.toEqual(
      pingId,
    );
  } finally {
    cogRPCClient.close();
  }
});

async function getPongEndpointKeyPairs(): Promise<{
  readonly sessionCert: Certificate;
  readonly identityCert: Certificate;
}> {
  const VAULT_URL = getEnvVar('VAULT_URL').required().asString();
  const VAULT_TOKEN = getEnvVar('VAULT_TOKEN').required().asString();
  const pongKeyStore = new VaultPrivateKeyStore(VAULT_URL, VAULT_TOKEN, 'pong-keys');

  const pongKeyId = base64DecodeEnvVar('PONG_ENDPOINT_KEY_ID');
  const identityCert = (await pongKeyStore.fetchNodeKey(pongKeyId)).certificate;
  const pongSessionKeyId = base64DecodeEnvVar('PONG_SESSION_ENDPOINT_KEY_ID');
  const sessionCert = (await pongKeyStore.fetchInitialSessionKey(pongSessionKeyId)).certificate;
  return { sessionCert, identityCert };
}

function base64DecodeEnvVar(envVarName: string): Buffer {
  const pongKeyIdBase64 = getEnvVar(envVarName).required().asString();
  return Buffer.from(pongKeyIdBase64, 'base64');
}

async function makePingParcel(
  pingId: string,
  recipientIdentityCert: Certificate,
  recipientSessionCert: Certificate,
  gwPDAChain: ExternalPdaChain,
): Promise<{
  readonly parcelId: string;
  readonly parcelSerialized: ArrayBuffer;
  readonly sessionKey: CryptoKey;
}> {
  const pongEndpointPda = await issueDeliveryAuthorization({
    issuerCertificate: gwPDAChain.peerEndpointCert,
    issuerPrivateKey: gwPDAChain.peerEndpointPrivateKey,
    subjectPublicKey: await recipientIdentityCert.getPublicKey(),
    validityEndDate: gwPDAChain.peerEndpointCert.expiryDate,
  });
  const pingSerialized = serializePing(pingId, pongEndpointPda, [
    gwPDAChain.peerEndpointCert,
    gwPDAChain.privateGatewayCert,
  ]);

  const serviceMessage = new ServiceMessage(
    'application/vnd.relaynet.ping-v1.ping',
    pingSerialized,
  );
  const pingEncryption = await SessionEnvelopedData.encrypt(
    serviceMessage.serialize(),
    recipientSessionCert,
  );
  const parcel = new Parcel(
    PONG_ENDPOINT_ADDRESS,
    gwPDAChain.peerEndpointCert,
    Buffer.from(pingEncryption.envelopedData.serialize()),
  );
  return {
    parcelId: parcel.id,
    parcelSerialized: await parcel.serialize(gwPDAChain.peerEndpointPrivateKey),
    sessionKey: pingEncryption.dhPrivateKey,
  };
}

function serializePing(id: string, pda: Certificate, pdaChain: readonly Certificate[]): Buffer {
  const pdaDerBase64 = serializeCertificate(pda);
  const pdaChainSerialized = pdaChain.map(serializeCertificate);
  const pingSerialized = JSON.stringify({ id, pda: pdaDerBase64, pdaChain: pdaChainSerialized });
  return Buffer.from(pingSerialized);
}

async function deserializePong(
  parcelSerialized: ArrayBuffer,
  sessionKey: CryptoKey,
): Promise<string> {
  const parcel = await Parcel.deserialize(parcelSerialized);
  const unwrapResult = await parcel.unwrapPayload(sessionKey);
  const serviceMessageContent = unwrapResult.payload.content;
  return serviceMessageContent.toString();
}

function serializeCertificate(certificate: Certificate): string {
  return Buffer.from(certificate.serialize()).toString('base64');
}

async function encapsulateParcelsInCargo(
  parcels: readonly ArrayBuffer[],
  gwPDAChain: ExternalPdaChain,
): Promise<Buffer> {
  const messageSet = new CargoMessageSet(parcels);
  const messageSetCiphertext = await SessionlessEnvelopedData.encrypt(
    messageSet.serialize(),
    gwPDAChain.publicGatewayCert,
  );
  const cargo = new Cargo(
    GW_PUBLIC_ADDRESS_URL,
    gwPDAChain.privateGatewayCert,
    Buffer.from(messageSetCiphertext.serialize()),
  );
  return Buffer.from(await cargo.serialize(gwPDAChain.privateGatewayPrivateKey));
}

async function extractMessagesFromCargo(
  cargoSerialized: Buffer,
  gwPDAChain: ExternalPdaChain,
): Promise<readonly ArrayBuffer[]> {
  const cargo = await Cargo.deserialize(bufferToArray(cargoSerialized));
  expect(cargo.recipientAddress).toEqual(
    await gwPDAChain.privateGatewayCert.calculateSubjectPrivateAddress(),
  );
  const { payload: cargoMessageSet } = await cargo.unwrapPayload(
    gwPDAChain.privateGatewayPrivateKey,
  );
  return Array.from(cargoMessageSet.messages);
}
