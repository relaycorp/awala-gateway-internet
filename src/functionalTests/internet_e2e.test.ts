import { CogRPCClient } from '@relaycorp/cogrpc';
import {
  Cargo,
  CargoMessageSet,
  getIdFromIdentityKey,
  issueDeliveryAuthorization,
  Parcel,
  ParcelCollectionAck,
  ParcelCollectionHandshakeSigner,
  ParcelDeliverySigner,
  PublicNodeConnectionParams,
  ServiceMessage,
  SessionEnvelopedData,
  SessionKey,
  StreamingMode,
} from '@relaycorp/relaynet-core';
import { PoWebClient } from '@relaycorp/relaynet-poweb';
import bufferToArray from 'buffer-to-arraybuffer';
import { get as httpGet } from 'http';
import { pipeline } from 'streaming-iterables';
import uuid from 'uuid-random';

import { arrayToAsyncIterable, asyncIterableToArray, iterableTake } from '../testUtils/iter';
import { ExternalPdaChain, generateCCA, generateCDAChain } from '../testUtils/pki';
import { deserializePong, serializePing } from './pingSerialization';
import {
  GW_COGRPC_LOCAL_URL,
  GW_INTERNET_ADDRESS,
  GW_POWEB_LOCAL_PORT,
  PONG_LOCAL_URL,
} from './services';
import { createAndRegisterPrivateGateway, IS_GITHUB, sleep } from './utils';

test('Sending pings via PoWeb and receiving pongs via PoHTTP', async () => {
  const powebClient = PoWebClient.initLocal(GW_POWEB_LOCAL_PORT);
  const { pdaChain } = await createAndRegisterPrivateGateway();

  const pingId = uuid();
  const pingParcelData = await makePingParcel(pingId, pdaChain);

  // Deliver the ping message
  await powebClient.deliverParcel(
    pingParcelData.parcelSerialized,
    new ParcelDeliverySigner(pdaChain.privateGatewayCert, pdaChain.privateGatewayPrivateKey),
  );

  // Collect the pong message once it's been received
  const incomingParcels = await pipeline(
    () =>
      powebClient.collectParcels(
        [
          new ParcelCollectionHandshakeSigner(
            pdaChain.privateGatewayCert,
            pdaChain.privateGatewayPrivateKey,
          ),
        ],
        StreamingMode.KEEP_ALIVE,
      ),
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
  const { pdaChain, publicGatewaySessionKey } = await createAndRegisterPrivateGateway();

  const pingId = uuid();
  const pingParcelData = await makePingParcel(pingId, pdaChain);

  const cogRPCClient = await CogRPCClient.init(GW_COGRPC_LOCAL_URL);
  try {
    // Deliver the ping message encapsulated in a cargo
    const cargoSerialized = await encapsulateParcelsInCargo(
      [pingParcelData.parcelSerialized],
      pdaChain,
      publicGatewaySessionKey,
    );
    await asyncIterableToArray(
      cogRPCClient.deliverCargo(
        arrayToAsyncIterable([{ localId: 'random-delivery-id', cargo: cargoSerialized }]),
      ),
    );

    await sleep(IS_GITHUB ? 4 : 2);

    // Collect the pong message encapsulated in a cargo
    const cdaChain = await generateCDAChain(pdaChain);
    const { ccaSerialized, sessionPrivateKey } = await generateCCA(
      GW_INTERNET_ADDRESS,
      publicGatewaySessionKey,
      cdaChain.publicGatewayCert,
      pdaChain.privateGatewayCert,
      pdaChain.privateGatewayPrivateKey,
    );
    const collectedCargoes = await asyncIterableToArray(cogRPCClient.collectCargo(ccaSerialized));
    expect(collectedCargoes).toHaveLength(1);
    const collectedMessages = await extractMessagesFromCargo(
      collectedCargoes[0],
      await pdaChain.privateGatewayCert.calculateSubjectId(),
      sessionPrivateKey,
    );
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

async function makePingParcel(
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

async function encapsulateParcelsInCargo(
  parcels: readonly ArrayBuffer[],
  gwPDAChain: ExternalPdaChain,
  publicGatewaySessionKey: SessionKey,
): Promise<Buffer> {
  const messageSet = new CargoMessageSet(parcels);
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

async function extractMessagesFromCargo(
  cargoSerialized: Buffer,
  recipientId: string,
  recipientSessionPrivateKey: CryptoKey,
): Promise<readonly ArrayBuffer[]> {
  const cargo = await Cargo.deserialize(bufferToArray(cargoSerialized));
  expect(cargo.recipient.id).toEqual(recipientId);
  const { payload: cargoMessageSet } = await cargo.unwrapPayload(recipientSessionPrivateKey);
  return Array.from(cargoMessageSet.messages);
}
