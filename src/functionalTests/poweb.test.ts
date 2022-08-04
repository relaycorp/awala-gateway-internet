import {
  derSerializePublicKey,
  generateRSAKeyPair,
  issueDeliveryAuthorization,
  issueEndpointCertificate,
  Parcel,
  ParcelCollectionHandshakeSigner,
  ParcelDeliverySigner,
  PrivateNodeRegistrationRequest,
  StreamingMode,
} from '@relaycorp/relaynet-core';
import {
  ParcelDeliveryError,
  PoWebClient,
  RefusedParcelError,
  ServerError,
} from '@relaycorp/relaynet-poweb';
import { pipeline } from 'streaming-iterables';

import { expectBuffersToEqual } from '../testUtils/buffers';
import { asyncIterableToArray, iterableTake } from '../testUtils/iter';
import { ExternalPdaChain } from '../testUtils/pki';
import { GW_POWEB_HOST_PORT } from './services';
import { createAndRegisterPrivateGateway, registerPrivateGateway, sleep } from './utils';

describe('Node registration', () => {
  test('Valid registration requests should be accepted', async () => {
    const client = PoWebClient.initLocal(GW_POWEB_HOST_PORT);
    const privateGatewayKeyPair = await generateRSAKeyPair();

    const registration = await registerPrivateGateway(privateGatewayKeyPair, client);

    await expect(
      derSerializePublicKey(await registration.privateNodeCertificate.getPublicKey()),
    ).resolves.toEqual(await derSerializePublicKey(privateGatewayKeyPair.publicKey));

    await expect(
      registration.privateNodeCertificate.getCertificationPath(
        [],
        [registration.gatewayCertificate],
      ),
    ).resolves.toHaveLength(2);
  });

  test('Registration request for different key should be refused', async () => {
    const client = PoWebClient.initLocal(GW_POWEB_HOST_PORT);
    const keyPair1 = await generateRSAKeyPair();
    const keyPair2 = await generateRSAKeyPair();

    const authorizationSerialized = await client.preRegisterNode(keyPair1.publicKey);
    const registrationRequest = new PrivateNodeRegistrationRequest(
      keyPair2.publicKey,
      authorizationSerialized,
    );
    const pnrrSerialized = await registrationRequest.serialize(keyPair2.privateKey);
    await expect(client.registerNode(pnrrSerialized)).rejects.toBeInstanceOf(ServerError);
  });
});

describe('Parcel delivery and collection', () => {
  test('Delivering and collecting a given parcel (closing upon completion)', async () => {
    const client = PoWebClient.initLocal(GW_POWEB_HOST_PORT);
    const { pdaChain: senderChain } = await createAndRegisterPrivateGateway();
    const { pdaChain: recipientChain } = await createAndRegisterPrivateGateway();

    const parcelSerialized = await generateDummyParcel(senderChain, recipientChain);

    await client.deliverParcel(
      parcelSerialized,
      new ParcelDeliverySigner(
        senderChain.privateGatewayCert,
        senderChain.privateGatewayPrivateKey,
      ),
    );

    await sleep(2);

    const parcelCollection = client.collectParcels(
      [
        new ParcelCollectionHandshakeSigner(
          recipientChain.privateGatewayCert,
          recipientChain.privateGatewayPrivateKey,
        ),
      ],
      StreamingMode.CLOSE_UPON_COMPLETION,
    );
    const incomingParcels = await pipeline(
      () => parcelCollection,
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

  test('Delivering and collecting a given parcel (keep alive)', async () => {
    const client = PoWebClient.initLocal(GW_POWEB_HOST_PORT);
    const { pdaChain: senderChain } = await createAndRegisterPrivateGateway();
    const { pdaChain: recipientChain } = await createAndRegisterPrivateGateway();

    const parcelSerialized = await generateDummyParcel(senderChain, recipientChain);

    await client.deliverParcel(
      parcelSerialized,
      new ParcelDeliverySigner(
        senderChain.privateGatewayCert,
        senderChain.privateGatewayPrivateKey,
      ),
    );

    const incomingParcels = await pipeline(
      () =>
        client.collectParcels(
          [
            new ParcelCollectionHandshakeSigner(
              recipientChain.privateGatewayCert,
              recipientChain.privateGatewayPrivateKey,
            ),
          ],
          StreamingMode.KEEP_ALIVE,
        ),
      async function* (collections): AsyncIterable<ArrayBuffer> {
        for await (const collection of collections) {
          yield await collection.parcelSerialized;
          await collection.ack();
        }
      },
      iterableTake(1),
      asyncIterableToArray,
    );
    expect(incomingParcels).toHaveLength(1);
    expectBuffersToEqual(parcelSerialized, incomingParcels[0]);
  });

  test('Invalid parcel deliveries should be refused', async () => {
    const client = PoWebClient.initLocal(GW_POWEB_HOST_PORT);
    const privateGatewayKeyPair = await generateRSAKeyPair();
    const privateGatewayRegistration = await registerPrivateGateway(privateGatewayKeyPair, client);

    const invalidKeyPair = await generateRSAKeyPair();

    await expect(
      client.deliverParcel(
        new ArrayBuffer(0),
        new ParcelDeliverySigner(
          privateGatewayRegistration.privateNodeCertificate,
          invalidKeyPair.privateKey,
        ),
      ),
    ).rejects.toBeInstanceOf(ParcelDeliveryError);
  });

  test('Invalid parcels should be refused', async () => {
    const client = PoWebClient.initLocal(GW_POWEB_HOST_PORT);
    const privateGatewayKeyPair = await generateRSAKeyPair();
    const privateGatewayRegistration = await registerPrivateGateway(privateGatewayKeyPair, client);

    const sendingEndpointKeyPair = await generateRSAKeyPair();
    const sendingEndpointCertificate = await issueEndpointCertificate({
      issuerCertificate: privateGatewayRegistration.privateNodeCertificate,
      issuerPrivateKey: privateGatewayKeyPair.privateKey,
      subjectPublicKey: sendingEndpointKeyPair.publicKey,
      validityEndDate: privateGatewayRegistration.privateNodeCertificate.expiryDate,
    });

    const parcel = new Parcel(
      { id: sendingEndpointCertificate.getIssuerId()! },
      sendingEndpointCertificate,
      Buffer.from([]),
    );
    const parcelSerialized = await parcel.serialize(sendingEndpointKeyPair.privateKey);

    await expect(
      client.deliverParcel(
        parcelSerialized,
        new ParcelDeliverySigner(
          privateGatewayRegistration.privateNodeCertificate,
          privateGatewayKeyPair.privateKey,
        ),
      ),
    ).rejects.toBeInstanceOf(RefusedParcelError);
  });
});

async function generateDummyParcel(
  senderChain: ExternalPdaChain,
  recipientChain: ExternalPdaChain,
): Promise<ArrayBuffer> {
  const recipientEndpointCertificate = recipientChain.peerEndpointCert;
  const sendingEndpointCertificate = await issueDeliveryAuthorization({
    issuerCertificate: recipientEndpointCertificate,
    issuerPrivateKey: recipientChain.peerEndpointPrivateKey,
    subjectPublicKey: await senderChain.peerEndpointCert.getPublicKey(),
    validityEndDate: recipientEndpointCertificate.expiryDate,
  });

  const parcel = new Parcel(
    { id: await recipientEndpointCertificate.calculateSubjectId() },
    sendingEndpointCertificate,
    Buffer.from([]),
    {
      senderCaCertificateChain: [recipientEndpointCertificate, recipientChain.privateGatewayCert],
    },
  );
  return parcel.serialize(senderChain.peerEndpointPrivateKey);
}
