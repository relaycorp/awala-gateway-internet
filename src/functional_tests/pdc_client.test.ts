// tslint:disable:no-let

import {
  Certificate,
  generateRSAKeyPair,
  issueEndpointCertificate,
  Parcel,
} from '@relaycorp/relaynet-core';
import { Stan } from 'node-nats-streaming';
import { promisify } from 'util';

import { configureServices, PONG_ENDPOINT_ADDRESS, startService, stopService } from './services';
import {
  connectToNatsStreaming,
  OBJECT_STORAGE_BUCKET,
  OBJECT_STORAGE_CLIENT,
  sleep,
} from './utils';

configureServices('pdc-outgoing-queue-worker', false);

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
afterEach(async () => natsStreamingConnection.close());

describe('PDC client', () => {
  test('Successfully delivered parcels should be taken off the queue', async () => {
    const parcel = new Parcel(PONG_ENDPOINT_ADDRESS, senderCertificate, Buffer.from([]));

    await queueParcel(parcel);

    await sleep(2);
    await expect(isParcelInStore(parcel)).resolves.toBeFalse();
  });

  test('Undelivered parcels should remain in the queue', async () => {
    await stopService('pong');
    try {
      const parcel = new Parcel(PONG_ENDPOINT_ADDRESS, senderCertificate, Buffer.from([]));

      await queueParcel(parcel);

      await sleep(2);
      await expect(isParcelInStore(parcel)).resolves.toBeTrue();
    } finally {
      await startService('pong');
    }
  });
});

async function queueParcel(parcel: Parcel): Promise<void> {
  // TODO: Use PoWebSockets once it's available, instead of messing with backing services

  const objectKey = makeParcelObjectKey(parcel.id);
  await OBJECT_STORAGE_CLIENT.putObject({
    Body: Buffer.from(await parcel.serialize(senderPrivateKey)),
    Bucket: OBJECT_STORAGE_BUCKET,
    Key: objectKey,
    Metadata: { 'parcel-expiry': Math.floor(parcel.expiryDate.getTime() / 1_000).toString() },
  }).promise();

  const natsPublish = promisify(natsStreamingConnection.publish).bind(natsStreamingConnection);
  await natsPublish(
    'crc-parcels',
    JSON.stringify({
      parcelExpiryDate: parcel.expiryDate,
      parcelObjectKey: parcel.id,
      parcelRecipientAddress: parcel.recipientAddress,
    }),
  );
}

async function isParcelInStore(parcel: Parcel): Promise<boolean> {
  try {
    await OBJECT_STORAGE_CLIENT.getObject({
      Bucket: OBJECT_STORAGE_BUCKET,
      Key: makeParcelObjectKey(parcel.id),
    }).promise();
  } catch (_) {
    return false;
  }
  return true;
}

function makeParcelObjectKey(parcelId: string): string {
  return `parcels/endpoint-bound/${parcelId}`;
}
