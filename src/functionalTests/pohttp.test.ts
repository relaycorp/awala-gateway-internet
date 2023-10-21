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
import { collect, pipeline } from 'streaming-iterables';

import { expectBuffersToEqual } from '../testUtils/buffers';
import { createAndRegisterPrivateGateway } from './utils/gatewayRegistration';
import { GW_POHTTP_HOST_URL, GW_POWEB_HOST_PORT } from './utils/constants';

describe('PoHTTP server', () => {
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
    await deliverParcel(GW_POHTTP_HOST_URL, parcelSerialized, { useTls: false });

    // The parcel should've been safely stored
    const poWebClient = PoWebClient.initLocal(GW_POWEB_HOST_PORT);
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
      collect,
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
      deliverParcel(GW_POHTTP_HOST_URL, await parcel.serialize(senderKeyPair.privateKey), {
        useTls: false,
      }),
    ).rejects.toThrow(PoHTTPInvalidParcelError);
  });
});
