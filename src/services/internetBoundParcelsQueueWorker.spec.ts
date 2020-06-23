// tslint:disable:no-let

import * as pohttp from '@relaycorp/relaynet-pohttp';
import { EnvVarError } from 'env-var';

import { arrayToAsyncIterable, mockPino, mockSpy } from '../_test_utils';
import { NatsStreamingClient } from '../backingServices/natsStreaming';
import { ObjectStoreClient } from '../backingServices/objectStorage';
import { configureMockEnvVars, mockStanMessage, TOMORROW } from './_test_utils';
import { ParcelStore } from './parcelStore';

const MOCK_PINO = mockPino();
import {
  processInternetBoundParcels,
  QueuedInternetBoundParcelMessage,
} from './internetBoundParcelsQueueWorker';

const OWN_POHTTP_ADDRESS = 'https://gateway.endpoint/';

const WORKER_NAME = 'the-worker';

const MOCK_NATS_CLIENT = {
  disconnect: mockSpy(jest.fn()),
  makeQueueConsumer: mockSpy(jest.fn()),
};
const MOCK_NATS_CLIENT_INIT = mockSpy(
  jest.spyOn(NatsStreamingClient, 'initFromEnv'),
  () => MOCK_NATS_CLIENT,
);

const ENV_VARS = {
  PARCEL_STORE_BUCKET: 'the-bucket',
};
const MOCK_ENV_VARS = configureMockEnvVars(ENV_VARS);

const MOCK_DELIVER_PARCEL = mockSpy(jest.spyOn(pohttp, 'deliverParcel'), async () => undefined);

const QUEUE_MESSAGE_DATA: QueuedInternetBoundParcelMessage = {
  parcelExpiryDate: TOMORROW,
  parcelObjectKey: 'foo.parcel',
  parcelRecipientAddress: 'https://endpoint.example/',
};
const QUEUE_MESSAGE_DATA_SERIALIZED = Buffer.from(JSON.stringify(QUEUE_MESSAGE_DATA));

const PARCEL_SERIALIZED = Buffer.from('Pretend this is a RAMF-serialized parcel');

mockSpy(jest.spyOn(ObjectStoreClient, 'initFromEnv'), () => undefined);

const MOCK_RETRIEVE_INTERNET_PARCEL = mockSpy(
  jest.spyOn(ParcelStore.prototype, 'retrieveEndpointBoundParcel'),
  async () => PARCEL_SERIALIZED,
);
const MOCK_DELETE_INTERNET_PARCEL = mockSpy(
  jest.spyOn(ParcelStore.prototype, 'deleteEndpointBoundParcel'),
  async () => undefined,
);

describe('processInternetBoundParcels', () => {
  test.each(Object.keys(ENV_VARS))('Environment variable %s should be present', async (envVar) => {
    MOCK_ENV_VARS({ ...ENV_VARS, [envVar]: undefined });

    await expect(
      processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS),
    ).rejects.toBeInstanceOf(EnvVarError);
  });

  test('Expired parcels should be skipped and deleted from store', async () => {
    const aSecondAgo = new Date();
    aSecondAgo.setSeconds(aSecondAgo.getSeconds() - 1);
    const messageData: QueuedInternetBoundParcelMessage = {
      parcelExpiryDate: aSecondAgo,
      parcelObjectKey: 'expired.parcel',
      parcelRecipientAddress: '',
    };
    const message = mockStanMessage(Buffer.from(JSON.stringify(messageData)));
    MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(arrayToAsyncIterable([message]));

    await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

    expect(message.ack).toBeCalledTimes(1);
    expect(MOCK_DELIVER_PARCEL).not.toBeCalled();

    expect(MOCK_RETRIEVE_INTERNET_PARCEL).not.toBeCalled();
    expect(MOCK_DELETE_INTERNET_PARCEL).toBeCalledWith(messageData.parcelObjectKey);
  });

  test('Parcel should be posted to server specified in queue message', async () => {
    MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(
      arrayToAsyncIterable([mockStanMessage(QUEUE_MESSAGE_DATA_SERIALIZED)]),
    );

    await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

    expect(MOCK_DELIVER_PARCEL).toBeCalledTimes(1);
    expect(MOCK_DELIVER_PARCEL).toBeCalledWith(
      QUEUE_MESSAGE_DATA.parcelRecipientAddress,
      PARCEL_SERIALIZED,
      expect.anything(),
    );
  });

  test('Parcels should be retrieved from the right bucket', async () => {
    MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(
      arrayToAsyncIterable([mockStanMessage(QUEUE_MESSAGE_DATA_SERIALIZED)]),
    );

    await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

    expect(MOCK_RETRIEVE_INTERNET_PARCEL.mock.instances[0]).toHaveProperty(
      'bucket',
      ENV_VARS.PARCEL_STORE_BUCKET,
    );
  });

  test('Gateway address should be specified when delivering parcel', async () => {
    MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(
      arrayToAsyncIterable([mockStanMessage(QUEUE_MESSAGE_DATA_SERIALIZED)]),
    );

    await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

    expect(MOCK_DELIVER_PARCEL).toBeCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        gatewayAddress: OWN_POHTTP_ADDRESS,
      }),
    );
  });

  test('Parcel should be deleted and taken off queue when successfully delivered', async () => {
    const message = mockStanMessage(QUEUE_MESSAGE_DATA_SERIALIZED);
    MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(arrayToAsyncIterable([message]));

    await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

    expect(message.ack).toBeCalledTimes(1);
    expect(MOCK_DELETE_INTERNET_PARCEL).toBeCalledWith(QUEUE_MESSAGE_DATA.parcelObjectKey);
    expect(MOCK_PINO.debug).toBeCalledWith(
      { parcelObjectKey: QUEUE_MESSAGE_DATA.parcelObjectKey },
      'Parcel was successfully delivered',
    );
  });

  test('Parcel should be discarded when server refuses it invalid', async () => {
    const err = new pohttp.PoHTTPInvalidParcelError('Parcel smells funny');
    MOCK_DELIVER_PARCEL.mockRejectedValue(err);
    const message = mockStanMessage(QUEUE_MESSAGE_DATA_SERIALIZED);
    MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(arrayToAsyncIterable([message]));

    await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

    expect(message.ack).toBeCalledTimes(1);
    expect(MOCK_DELETE_INTERNET_PARCEL).toBeCalledWith(QUEUE_MESSAGE_DATA.parcelObjectKey);
    expect(MOCK_PINO.info).toBeCalledWith(
      { err, parcelObjectKey: QUEUE_MESSAGE_DATA.parcelObjectKey },
      'Parcel was rejected as invalid',
    );
  });

  test('Parcel should be redelivered later if transient delivery error occurs', async () => {
    const err = new pohttp.PoHTTPError('Server is down');
    MOCK_DELIVER_PARCEL.mockRejectedValue(err);
    const message = mockStanMessage(QUEUE_MESSAGE_DATA_SERIALIZED);
    MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(arrayToAsyncIterable([message]));

    await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

    expect(MOCK_PINO.warn).toBeCalledWith(
      { err, parcelObjectKey: QUEUE_MESSAGE_DATA.parcelObjectKey },
      'Failed to deliver parcel',
    );
    expect(message.ack).not.toBeCalled();
    expect(MOCK_DELETE_INTERNET_PARCEL).not.toBeCalled();
  });

  describe('NATS Streaming connection', () => {
    test('NAT Streaming client id should match worker name', async () => {
      MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(arrayToAsyncIterable([]));

      await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

      expect(MOCK_NATS_CLIENT_INIT).toBeCalledWith(WORKER_NAME);
    });

    test('NATS connection should be closed upon successful completion', async () => {
      MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(
        arrayToAsyncIterable([mockStanMessage(QUEUE_MESSAGE_DATA_SERIALIZED)]),
      );

      await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

      expect(MOCK_NATS_CLIENT.disconnect).toBeCalled();
    });

    test('NATS connection should be closed upon error', async () => {
      MOCK_DELIVER_PARCEL.mockRejectedValue(new pohttp.PoHTTPError('Server is down'));
      MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(
        arrayToAsyncIterable([mockStanMessage(QUEUE_MESSAGE_DATA_SERIALIZED)]),
      );

      await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

      expect(MOCK_NATS_CLIENT.disconnect).toBeCalled();
    });
  });

  describe('NATS Streaming Consumer', () => {
    test('Channel should be "crc-parcels"', async () => {
      MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(arrayToAsyncIterable([]));

      await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

      expect(MOCK_NATS_CLIENT.makeQueueConsumer).toBeCalledWith(
        'crc-parcels',
        expect.anything(),
        expect.anything(),
      );
    });

    test('Queue should be "worker"', async () => {
      MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(arrayToAsyncIterable([]));

      await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

      expect(MOCK_NATS_CLIENT.makeQueueConsumer).toBeCalledWith(
        expect.anything(),
        'worker',
        expect.anything(),
      );
    });

    test('Durable name should be "worker"', async () => {
      MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(arrayToAsyncIterable([]));

      await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

      expect(MOCK_NATS_CLIENT.makeQueueConsumer).toBeCalledWith(
        expect.anything(),
        expect.anything(),
        'worker',
      );
    });
  });
});
