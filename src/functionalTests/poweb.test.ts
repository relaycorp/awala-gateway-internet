import {
  derSerializePublicKey,
  generateRSAKeyPair,
  issueDeliveryAuthorization,
  issueEndpointCertificate,
  Parcel,
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
import uuid from 'uuid-random';

import { ExternalPdaChain } from '../testUtils/pki';
import { GW_POWEB_HOST_PORT } from './utils/constants';
import {
  createAndRegisterPrivateGateway,
  registerPrivateGateway,
} from './utils/gatewayRegistration';
import { extractPong, makePingParcel } from './utils/ping';
import { collectNextParcel, waitForNextParcel } from './utils/poweb';

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

describe('Parcel delivery', () => {
  test('Invalid deliveries should be refused', async () => {
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

describe('Parcel delivery and collection (end-to-end)', () => {
  test('Delivering and collecting a parcel (keep alive)', async () => {
    const client = PoWebClient.initLocal(GW_POWEB_HOST_PORT);
    const { pdaChain: senderChain } = await createAndRegisterPrivateGateway();
    const { pdaChain: recipientChain } = await createAndRegisterPrivateGateway();

    const { parcel, parcelSerialized } = await generateDummyParcel(senderChain, recipientChain);

    await client.deliverParcel(
      parcelSerialized,
      new ParcelDeliverySigner(
        senderChain.privateGatewayCert,
        senderChain.privateGatewayPrivateKey,
      ),
    );

    const incomingParcel = await collectNextParcel(
      client,
      recipientChain,
      StreamingMode.KEEP_ALIVE,
    );
    expect(incomingParcel.id).toEqual(parcel.id);
  });

  test('Delivering and collecting a parcel (closing upon completion)', async () => {
    const client = PoWebClient.initLocal(GW_POWEB_HOST_PORT);
    const { pdaChain: senderChain } = await createAndRegisterPrivateGateway();
    const { pdaChain: recipientChain } = await createAndRegisterPrivateGateway();

    const { parcel, parcelSerialized } = await generateDummyParcel(senderChain, recipientChain);

    await client.deliverParcel(
      parcelSerialized,
      new ParcelDeliverySigner(
        senderChain.privateGatewayCert,
        senderChain.privateGatewayPrivateKey,
      ),
    );

    await waitForNextParcel(client, recipientChain);
    const incomingParcel = await collectNextParcel(
      client,
      recipientChain,
      StreamingMode.CLOSE_UPON_COMPLETION,
    );
    expect(incomingParcel.id).toEqual(parcel.id);
  });

  test('Sending pings and receiving pongs (communication with Internet node)', async () => {
    const client = PoWebClient.initLocal(GW_POWEB_HOST_PORT);
    const { pdaChain } = await createAndRegisterPrivateGateway();

    const pingId = uuid();
    const { parcelSerialized: pingParcelSerialized, sessionKey } = await makePingParcel(
      pingId,
      pdaChain,
    );

    await client.deliverParcel(
      pingParcelSerialized,
      new ParcelDeliverySigner(pdaChain.privateGatewayCert, pdaChain.privateGatewayPrivateKey),
    );

    const pongParcel = await collectNextParcel(client, pdaChain);
    await expect(extractPong(pongParcel, sessionKey)).resolves.toEqual(pingId);
  });
});

interface GeneratedParcel {
  readonly parcel: Parcel;
  readonly parcelSerialized: ArrayBuffer;
}

async function generateDummyParcel(
  senderChain: ExternalPdaChain,
  recipientChain: ExternalPdaChain,
): Promise<GeneratedParcel> {
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
  const parcelSerialized = await parcel.serialize(senderChain.peerEndpointPrivateKey);
  return { parcel, parcelSerialized };
}
