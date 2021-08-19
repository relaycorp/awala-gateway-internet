import {
  generateRSAKeyPair,
  issueEndpointCertificate,
  Parcel,
  Signer,
  StreamingMode,
} from '@relaycorp/relaynet-core';
import { deliverParcel, PoHTTPInvalidParcelError } from '@relaycorp/relaynet-pohttp';
import { PoWebClient } from '@relaycorp/relaynet-poweb';
import pipe from 'it-pipe';

import { asyncIterableToArray } from '../_test_utils';
import { expectBuffersToEqual } from '../services/_test_utils';

import { GW_POHTTP_URL, GW_POWEB_LOCAL_PORT } from './services';
import { generatePdaChain } from './utils';

describe('PoHTTP server', () => {
  test('Valid parcel should be accepted', async () => {
    const pdaChain = await generatePdaChain();
    const parcel = new Parcel(
      await pdaChain.peerEndpointCert.calculateSubjectPrivateAddress(),
      pdaChain.pdaCert,
      Buffer.from([]),
      { senderCaCertificateChain: [pdaChain.peerEndpointCert, pdaChain.privateGatewayCert] },
    );
    const parcelSerialized = await parcel.serialize(pdaChain.pdaGranteePrivateKey);

    // We should get a successful response
    await deliverParcel(GW_POHTTP_URL, parcelSerialized);

    // The parcel should've been safely stored
    const poWebClient = PoWebClient.initLocal(GW_POWEB_LOCAL_PORT);
    const signer = new Signer(pdaChain.privateGatewayCert, pdaChain.privateGatewayPrivateKey);
    const incomingParcels = await pipe(
      poWebClient.collectParcels([signer], StreamingMode.CLOSE_UPON_COMPLETION),
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
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const senderCertificate = await issueEndpointCertificate({
      issuerPrivateKey: senderKeyPair.privateKey,
      subjectPublicKey: senderKeyPair.publicKey,
      validityEndDate: tomorrow,
    });
    const parcel = new Parcel('0deadbeef', senderCertificate, Buffer.from([]));

    await expect(
      deliverParcel(GW_POHTTP_URL, await parcel.serialize(senderKeyPair.privateKey)),
    ).rejects.toBeInstanceOf(PoHTTPInvalidParcelError);
  });
});
