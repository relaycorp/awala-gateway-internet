import { generateRSAKeyPair, issueEndpointCertificate, Parcel } from '@relaycorp/relaynet-core';
import { deliverParcel, PoHTTPInvalidParcelError } from '@relaycorp/relaynet-pohttp';
import { Message, Stan } from 'node-nats-streaming';

import { configureServices } from './services';
import {
  connectToNatsStreaming,
  generatePdaChain,
  OBJECT_STORAGE_BUCKET,
  OBJECT_STORAGE_CLIENT,
} from './utils';

const GW_POHTTP_URL = 'http://127.0.0.1:8080';

configureServices();

describe('PoHTTP server', () => {
  // tslint:disable-next-line:no-let
  let stanConnection: Stan;
  beforeEach(async () => (stanConnection = await connectToNatsStreaming()));
  afterEach(async () => stanConnection.close());

  test('Valid parcel should be accepted', async (cb) => {
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
    // TODO: Use the PoWebSockets interface instead once it's available
    const subscription = stanConnection.subscribe(
      `pdc-parcel.${await pdaChain.privateGatewayCert.calculateSubjectPrivateAddress()}`,
      'functional-tests',
      stanConnection.subscriptionOptions().setDeliverAllAvailable(),
    );
    subscription.on('error', cb);
    subscription.on('message', async (message: Message) => {
      const objectKey = message.getData() as string;
      await expect(
        OBJECT_STORAGE_CLIENT.getObject({
          Bucket: OBJECT_STORAGE_BUCKET,
          Key: objectKey,
        }).promise(),
      ).resolves.toMatchObject({ Body: Buffer.from(parcelSerialized) });
      cb();
    });
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

    try {
      await deliverParcel(GW_POHTTP_URL, await parcel.serialize(senderKeyPair.privateKey));
    } catch (error) {
      expect(error).toBeInstanceOf(PoHTTPInvalidParcelError);
      return;
    }
    expect.fail("Parcel delivery should've failed");
  });
});
