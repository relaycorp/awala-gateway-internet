import {
  generateRSAKeyPair,
  issueEndpointCertificate,
  Parcel,
  ParcelCollectionHandshakeSigner,
  StreamingMode,
} from '@relaycorp/relaynet-core';
import { deliverParcel, PoHTTPInvalidParcelError } from '@relaycorp/relaynet-pohttp';
import { PoWebClient } from '@relaycorp/relaynet-poweb';
import { addDays } from 'date-fns';
import { Stan } from 'node-nats-streaming';
import { pipeline } from 'streaming-iterables';

import { expectBuffersToEqual } from '../testUtils/buffers';
import { asyncIterableToArray } from '../testUtils/iter';
import { GW_POHTTP_LOCAL_URL, GW_POWEB_LOCAL_PORT } from './services';
import { connectToNatsStreaming, createAndRegisterPrivateGateway } from './utils';

describe('PoHTTP server', () => {
  let stanConnection: Stan;
  beforeEach(async () => (stanConnection = await connectToNatsStreaming()));
  afterEach(async () => {
    stanConnection.close();
    await new Promise((resolve) => stanConnection.once('close', resolve));
  });

  test('Valid parcel should be accepted', async () => {
    const { pdaChain } = await createAndRegisterPrivateGateway();
    const parcel = new Parcel(
      { id: await pdaChain.peerEndpointCert.calculateSubjectId() },
      pdaChain.pdaCert,
      Buffer.from([]),
      { senderCaCertificateChain: [pdaChain.peerEndpointCert, pdaChain.privateGatewayCert] },
    );
    const parcelSerialized = await parcel.serialize(pdaChain.pdaGranteePrivateKey);

    // We should get a successful response
    await deliverParcel(GW_POHTTP_LOCAL_URL, parcelSerialized, { useTls: false });

    // The parcel should've been safely stored
    const poWebClient = PoWebClient.initLocal(GW_POWEB_LOCAL_PORT);
    const signer = new ParcelCollectionHandshakeSigner(
      pdaChain.privateGatewayCert,
      pdaChain.privateGatewayPrivateKey,
    );
    const incomingParcels = await pipeline(
      () => poWebClient.collectParcels([signer], StreamingMode.CLOSE_UPON_COMPLETION),
      async function* (collections): AsyncIterable<ArrayBuffer> {
        for await (const collection of collections) {
          yield await collection.parcelSerialized;
          await collection.ack();
        }
      },
      asyncIterableToArray,
    );
    expect(incomingParcels).toHaveLength(1);
    expectBuffersToEqual(parcelSerialized, incomingParcels[0]);
  });

  test('Unauthorized parcel should be refused', async () => {
    const senderKeyPair = await generateRSAKeyPair();
    const senderCertificate = await issueEndpointCertificate({
      issuerPrivateKey: senderKeyPair.privateKey,
      subjectPublicKey: senderKeyPair.publicKey,
      validityEndDate: addDays(new Date(), 1),
    });
    const parcel = new Parcel(
      { id: senderCertificate.getIssuerId()! },
      senderCertificate,
      Buffer.from([]),
    );

    await expect(
      deliverParcel(GW_POHTTP_LOCAL_URL, await parcel.serialize(senderKeyPair.privateKey), {
        useTls: false,
      }),
    ).rejects.toThrow(PoHTTPInvalidParcelError);
  });
});
