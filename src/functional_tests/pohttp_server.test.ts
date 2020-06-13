import { generateRSAKeyPair, issueEndpointCertificate, Parcel } from '@relaycorp/relaynet-core';
import { deliverParcel, PoHTTPError } from '@relaycorp/relaynet-pohttp';
import { AxiosError } from 'axios';
import { get as getEnvVar } from 'env-var';
import { connect as stanConnect, Message, Stan } from 'node-nats-streaming';

import { bootstrapData, setUpServices, tearDownServices } from './services';
import { generatePdaChain, OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_CLIENT, sleep } from './utils';

const GW_POHTTP_URL = 'http://127.0.0.1:8080';

describe('PoHTTP server', () => {
  beforeAll(async () => {
    jest.setTimeout(15_000);
    await tearDownServices();
    await setUpServices(['pohttp', 'vault']);
    await sleep(2);
    await bootstrapData();
  });
  afterAll(tearDownServices);

  // tslint:disable-next-line:no-let
  let stanConnection: Stan;
  beforeAll(
    async () =>
      new Promise(resolve => {
        stanConnection = stanConnect(
          getEnvVar('NATS_CLUSTER_ID')
            .required()
            .asString(),
          'functional-tests',
          {
            url: getEnvVar('NATS_SERVER_URL')
              .required()
              .asString(),
          },
        );
        stanConnection.on('connect', resolve);
      }),
  );
  afterAll(async () => stanConnection.close());

  test('Valid parcel should be accepted', async cb => {
    const pdaChain = await generatePdaChain();
    const parcel = new Parcel(
      await pdaChain.peerEndpointCertificate.calculateSubjectPrivateAddress(),
      pdaChain.pda,
      Buffer.from([]),
      { senderCaCertificateChain: pdaChain.chain },
    );
    const parcelSerialized = Buffer.from(await parcel.serialize(pdaChain.privateKey));

    // We should get a successful response
    await expect(deliverParcel(GW_POHTTP_URL, parcelSerialized)).toResolve();

    // The parcel should've been safely stored
    const subscription = stanConnection.subscribe(
      `pdc-parcel.${await pdaChain.privateGatewayCertificate.calculateSubjectPrivateAddress()}`,
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
      ).resolves.toMatchObject({ Body: parcelSerialized });
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

    await expect(
      deliverParcel(GW_POHTTP_URL, await parcel.serialize(senderKeyPair.privateKey)),
    ).rejects.toSatisfy((err: PoHTTPError) => {
      const response = (err.cause() as AxiosError).response;
      return (
        response!.status === 400 && response!.data.message === 'Parcel sender is not authorized'
      );
    });
  });
});
