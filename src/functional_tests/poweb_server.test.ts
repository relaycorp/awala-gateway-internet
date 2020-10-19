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

import { asyncIterableToArray } from '../_test_utils';
import { configureServices, GW_POWEB_LOCAL_PORT } from './services';
import { getPublicGatewayCertificate, registerPrivateGateway, sleep } from './utils';

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
    test('Delivering and collecting a given parcel', async () => {
      const client = PoWebClient.initLocal(GW_POWEB_LOCAL_PORT);
      const privateGateway1KeyPair = await generateRSAKeyPair();
      const privateGateway1Registration = await registerPrivateGateway(
        privateGateway1KeyPair,
        client,
      );
      const privateGateway2KeyPair = await generateRSAKeyPair();
      const privateGateway2Registration = await registerPrivateGateway(
        privateGateway2KeyPair,
        client,
      );

      const receivingEndpointKeyPair = await generateRSAKeyPair();
      const receivingEndpointCertificate = await issueEndpointCertificate({
        issuerCertificate: privateGateway2Registration.privateNodeCertificate,
        issuerPrivateKey: privateGateway2KeyPair.privateKey,
        subjectPublicKey: receivingEndpointKeyPair.publicKey,
        validityEndDate: privateGateway2Registration.privateNodeCertificate.expiryDate,
      });
      const sendingEndpointKeyPair = await generateRSAKeyPair();
      const sendingEndpointCertificate = await issueDeliveryAuthorization({
        issuerCertificate: receivingEndpointCertificate,
        issuerPrivateKey: receivingEndpointKeyPair.privateKey,
        subjectPublicKey: sendingEndpointKeyPair.publicKey,
        validityEndDate: receivingEndpointCertificate.expiryDate,
      });

      const parcel = new Parcel(
        await receivingEndpointCertificate.calculateSubjectPrivateAddress(),
        sendingEndpointCertificate,
        Buffer.from([]),
        {
          senderCaCertificateChain: [
            receivingEndpointCertificate,
            privateGateway2Registration.privateNodeCertificate,
          ],
        },
      );
      const parcelSerialized = await parcel.serialize(sendingEndpointKeyPair.privateKey);

      await client.deliverParcel(
        parcelSerialized,
        new Signer(
          privateGateway1Registration.privateNodeCertificate,
          privateGateway1KeyPair.privateKey,
        ),
      );

      await sleep(2);

      const parcelCollection = client.collectParcels(
        [
          new Signer(
            privateGateway2Registration.privateNodeCertificate,
            privateGateway2KeyPair.privateKey,
          ),
        ],
        StreamingMode.CLOSE_UPON_COMPLETION,
      );
      const incomingParcels = await pipe(
        parcelCollection,
        async function* (collections): AsyncIterable<Parcel> {
          for await (const collection of collections) {
            yield await collection.deserializeAndValidateParcel();
            await collection.ack();
          }
        },
        asyncIterableToArray,
      );
      expect(incomingParcels).toHaveLength(1);
      expect(incomingParcels[0].id).toEqual(parcel.id);
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
