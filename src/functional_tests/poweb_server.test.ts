import {
  derSerializePublicKey,
  generateRSAKeyPair,
  issueDeliveryAuthorization,
  issueEndpointCertificate,
  Parcel,
  PrivateNodeRegistrationRequest,
  Signer,
} from '@relaycorp/relaynet-core';
import {
  ParcelDeliveryError,
  PoWebClient,
  RefusedParcelError,
  ServerError,
  StreamingMode,
} from '@relaycorp/relaynet-poweb';
import pipe from 'it-pipe';

import { asyncIterableToArray, iterableTake, PdaChain } from '../_test_utils';
import { expectBuffersToEqual } from '../services/_test_utils';
import { configureServices, GW_POWEB_LOCAL_PORT } from './services';
import {
  generatePdaChain,
  getPublicGatewayCertificate,
  registerPrivateGateway,
  sleep,
} from './utils';

configureServices(['poweb']);

describe('PoWeb server', () => {
  describe('Node registration', () => {
    test('Valid registration requests should be accepted', async () => {
      const client = PoWebClient.initLocal(GW_POWEB_LOCAL_PORT);
      const privateGatewayKeyPair = await generateRSAKeyPair();

      const registration = await registerPrivateGateway(privateGatewayKeyPair, client);

      await expect(
        derSerializePublicKey(await registration.privateNodeCertificate.getPublicKey()),
      ).resolves.toEqual(await derSerializePublicKey(privateGatewayKeyPair.publicKey));

      const actualPublicGatewayCertificate = await getPublicGatewayCertificate();
      expect(actualPublicGatewayCertificate.isEqual(registration.gatewayCertificate)).toBeTrue();

      await expect(
        registration.privateNodeCertificate.getCertificationPath(
          [],
          [registration.gatewayCertificate],
        ),
      ).resolves.toHaveLength(2);
    });

    test('Registration request for different key should be refused', async () => {
      const client = PoWebClient.initLocal(GW_POWEB_LOCAL_PORT);
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
      const client = PoWebClient.initLocal(GW_POWEB_LOCAL_PORT);
      const senderChain = await generatePdaChain();
      const recipientChain = await generatePdaChain();

      const parcelSerialized = await generateDummyParcel(senderChain, recipientChain);

      await client.deliverParcel(
        parcelSerialized,
        new Signer(senderChain.privateGatewayCert, senderChain.privateGatewayPrivateKey),
      );

      await sleep(2);

      const parcelCollection = client.collectParcels(
        [new Signer(recipientChain.privateGatewayCert, recipientChain.privateGatewayPrivateKey)],
        StreamingMode.CLOSE_UPON_COMPLETION,
      );
      const incomingParcels = await pipe(
        parcelCollection,
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
      const client = PoWebClient.initLocal(GW_POWEB_LOCAL_PORT);
      const senderChain = await generatePdaChain();
      const recipientChain = await generatePdaChain();

      const parcelSerialized = await generateDummyParcel(senderChain, recipientChain);

      await client.deliverParcel(
        parcelSerialized,
        new Signer(senderChain.privateGatewayCert, senderChain.privateGatewayPrivateKey),
      );

      const incomingParcels = await pipe(
        client.collectParcels(
          [new Signer(recipientChain.privateGatewayCert, recipientChain.privateGatewayPrivateKey)],
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
      const client = PoWebClient.initLocal(GW_POWEB_LOCAL_PORT);
      const privateGatewayKeyPair = await generateRSAKeyPair();
      const privateGatewayRegistration = await registerPrivateGateway(
        privateGatewayKeyPair,
        client,
      );

      const invalidKeyPair = await generateRSAKeyPair();

      await expect(
        client.deliverParcel(
          new ArrayBuffer(0),
          new Signer(privateGatewayRegistration.privateNodeCertificate, invalidKeyPair.privateKey),
        ),
      ).rejects.toBeInstanceOf(ParcelDeliveryError);
    });

    test('Invalid parcels should be refused', async () => {
      const client = PoWebClient.initLocal(GW_POWEB_LOCAL_PORT);
      const privateGatewayKeyPair = await generateRSAKeyPair();
      const privateGatewayRegistration = await registerPrivateGateway(
        privateGatewayKeyPair,
        client,
      );

      const sendingEndpointKeyPair = await generateRSAKeyPair();
      const sendingEndpointCertificate = await issueEndpointCertificate({
        issuerCertificate: privateGatewayRegistration.privateNodeCertificate,
        issuerPrivateKey: privateGatewayKeyPair.privateKey,
        subjectPublicKey: sendingEndpointKeyPair.publicKey,
        validityEndDate: privateGatewayRegistration.privateNodeCertificate.expiryDate,
      });

      const parcel = new Parcel('0deadbeef', sendingEndpointCertificate, Buffer.from([]));
      const parcelSerialized = await parcel.serialize(sendingEndpointKeyPair.privateKey);

      await expect(
        client.deliverParcel(
          parcelSerialized,
          new Signer(
            privateGatewayRegistration.privateNodeCertificate,
            privateGatewayKeyPair.privateKey,
          ),
        ),
      ).rejects.toBeInstanceOf(RefusedParcelError);
    });
  });
});

async function generateDummyParcel(
  senderChain: PdaChain,
  recipientChain: PdaChain,
): Promise<ArrayBuffer> {
  const recipientEndpointCertificate = recipientChain.peerEndpointCert;
  const sendingEndpointCertificate = await issueDeliveryAuthorization({
    issuerCertificate: recipientEndpointCertificate,
    issuerPrivateKey: recipientChain.peerEndpointPrivateKey,
    subjectPublicKey: await senderChain.peerEndpointCert.getPublicKey(),
    validityEndDate: recipientEndpointCertificate.expiryDate,
  });

  const parcel = new Parcel(
    await recipientEndpointCertificate.calculateSubjectPrivateAddress(),
    sendingEndpointCertificate,
    Buffer.from([]),
    {
      senderCaCertificateChain: [recipientEndpointCertificate, recipientChain.privateGatewayCert],
    },
  );
  return parcel.serialize(senderChain.peerEndpointPrivateKey);
}
