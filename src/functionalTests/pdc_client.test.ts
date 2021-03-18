import {
  Certificate,
  generateRSAKeyPair,
  issueEndpointCertificate,
  Parcel,
} from '@relaycorp/relaynet-core';
import { Stan } from 'node-nats-streaming';
import { promisify } from 'util';

import { PONG_ENDPOINT_ADDRESS } from './services';
import {
  connectToNatsStreaming,
  IS_GITHUB,
  OBJECT_STORAGE_BUCKET,
  OBJECT_STORAGE_CLIENT,
  sleep,
} from './utils';

let senderPrivateKey: CryptoKey;
let senderCertificate: Certificate;
beforeAll(async () => {
  const keyPair = await generateRSAKeyPair();
  senderPrivateKey = keyPair.privateKey;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  senderCertificate = await issueEndpointCertificate({
    issuerPrivateKey: senderPrivateKey,
    subjectPublicKey: keyPair.publicKey,
    validityEndDate: tomorrow,
  });
});

let natsStreamingConnection: Stan;
beforeEach(async () => (natsStreamingConnection = await connectToNatsStreaming()));
afterEach(async () => {
  // Shut up Jest about leaving open handlers
  await new Promise((resolve) => {
    natsStreamingConnection.once('close', resolve);
    natsStreamingConnection.close();
  });
});

describe('PDC client', () => {
  test('Successfully delivered parcels should be taken off the queue', async () => {
    const parcel = new Parcel(PONG_ENDPOINT_ADDRESS, senderCertificate, Buffer.from([]));

    await queueParcel(parcel);

    await sleep(IS_GITHUB ? 5 : 3);
    await expect(isParcelInStore(parcel)).resolves.toBeFalse();
  });

  test('Undelivered parcels should remain in the queue', async () => {
    const parcel = new Parcel('https://relaynet.local', senderCertificate, Buffer.from([]), {
      ttl: 10,
    });

    await queueParcel(parcel);

    await sleep(IS_GITHUB ? 5 : 2);
    await expect(isParcelInStore(parcel)).resolves.toBeTrue();
  });
});

async function queueParcel(parcel: Parcel): Promise<void> {
  // TODO: Use PoWebSockets once it's available, instead of messing with backing services

  const objectKey = makeParcelObjectKey(parcel.id);
  await OBJECT_STORAGE_CLIENT.putObject(
    {
      body: Buffer.from(await parcel.serialize(senderPrivateKey)),
      metadata: { 'parcel-expiry': Math.floor(parcel.expiryDate.getTime() / 1_000).toString() },
    },
    objectKey,
    OBJECT_STORAGE_BUCKET,
  );

  const natsPublish = promisify(natsStreamingConnection.publish).bind(natsStreamingConnection);
  await natsPublish(
    'internet-parcels',
    JSON.stringify({
      parcelExpiryDate: parcel.expiryDate,
      parcelObjectKey: parcel.id,
      parcelRecipientAddress: parcel.recipientAddress,
    }),
  );
}

async function isParcelInStore(parcel: Parcel): Promise<boolean> {
  const parcelObject = await OBJECT_STORAGE_CLIENT.getObject(
    makeParcelObjectKey(parcel.id),
    OBJECT_STORAGE_BUCKET,
  );
  return !!parcelObject;
}

function makeParcelObjectKey(parcelId: string): string {
  return `parcels/endpoint-bound/${parcelId}`;
}
