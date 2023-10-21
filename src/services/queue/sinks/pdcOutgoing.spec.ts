import * as pohttp from '@relaycorp/relaynet-pohttp';
import { CloudEvent } from 'cloudevents';
import { addDays, setMilliseconds } from 'date-fns';

import { EnvVarMocker } from '../../../testUtils/envVars';
import { getMockInstance } from '../../../testUtils/jest';
import { partialPinoLog } from '../../../testUtils/logging';
import { makeMockQueueServer, makeQueueEventPoster, QUEUE_ENV_VARS } from '../_test_utils';
import { HTTP_STATUS_CODES } from '../../../utilities/http';
import { EVENT_TYPES } from './types';
import { mockRedisPubSubClient } from '../../../testUtils/redis';

jest.mock('../../../utilities/exitHandling');
jest.mock('../../../node/InternetGatewayManager');
jest.mock('../../../parcelStore');
jest.mock('@relaycorp/relaynet-pohttp', () => {
  const actualPohttp = jest.requireActual('@relaycorp/relaynet-pohttp');
  return {
    ...actualPohttp,
    deliverParcel: jest.fn(),
  };
});
beforeEach(() => {
  getMockInstance(pohttp.deliverParcel).mockRestore();
});

mockRedisPubSubClient();
const getContext = makeMockQueueServer();
const postQueueEvent = makeQueueEventPoster(getContext);

describe('pdcOutgoing', () => {
  const parcelId = 'the parcel id';
  const recipientInternetAddress = 'endpoint.example.com';
  const parcelExpiry = addDays(new Date(), 1);
  const parcelSerialised = Buffer.from('Pretend this is a RAMF-serialized parcel');
  const privatePeerId = 'the-private-gateway-id';
  const event = new CloudEvent({
    type: EVENT_TYPES.PDC_OUTGOING_PARCEL,
    source: privatePeerId,
    subject: parcelId,
    internetaddress: recipientInternetAddress,
    expiry: parcelExpiry.toISOString(),
    datacontenttype: 'application/foo',
    data: parcelSerialised,
  });

  const logAttributes = { parcelId, privatePeerId };

  describe('Attribute validation', () => {
    test('Subject should be present', async () => {
      const invalidEvent = event.cloneWith({ subject: undefined });

      await expect(postQueueEvent(invalidEvent)).resolves.toBe(HTTP_STATUS_CODES.NO_CONTENT);

      expect(getContext().logs).toContainEqual(
        partialPinoLog('warn', 'Refused outgoing parcel with missing subject', { privatePeerId }),
      );
      expect(pohttp.deliverParcel).not.toBeCalled();
    });

    test('Parcel expiry should be present', async () => {
      const invalidEvent = event.cloneWith({ expiry: undefined }, false);

      await expect(postQueueEvent(invalidEvent)).resolves.toBe(HTTP_STATUS_CODES.NO_CONTENT);

      expect(getContext().logs).toContainEqual(
        partialPinoLog('warn', 'Refused outgoing parcel with missing expiry', logAttributes),
      );
      expect(pohttp.deliverParcel).not.toBeCalled();
    });

    test('Recipient Internet address id should be present', async () => {
      const invalidEvent = event.cloneWith({ internetaddress: undefined }, false);

      await expect(postQueueEvent(invalidEvent)).resolves.toBe(HTTP_STATUS_CODES.NO_CONTENT);

      expect(getContext().logs).toContainEqual(
        partialPinoLog(
          'warn',
          'Refused outgoing parcel with missing recipient Internet address',
          logAttributes,
        ),
      );
      expect(pohttp.deliverParcel).not.toBeCalled();
    });
  });

  test('Expired parcels should be skipped and deleted from store', async () => {
    const now = setMilliseconds(new Date(), 0);
    const expiredParcelEvent = event.cloneWith({ expiry: now.toISOString() });

    await expect(postQueueEvent(expiredParcelEvent)).resolves.toBe(HTTP_STATUS_CODES.NO_CONTENT);

    expect(getContext().logs).toContainEqual(
      partialPinoLog('info', 'Ignoring expired parcel', {
        ...logAttributes,
        expiry: now.toISOString(),
      }),
    );
    expect(pohttp.deliverParcel).not.toBeCalled();
  });

  test('Parcel should be posted to server specified in queue message', async () => {
    await expect(postQueueEvent(event)).resolves.toBe(HTTP_STATUS_CODES.NO_CONTENT);

    expect(pohttp.deliverParcel).toBeCalledTimes(1);
    expect(pohttp.deliverParcel).toBeCalledWith(
      recipientInternetAddress,
      parcelSerialised,
      expect.anything(),
    );
  });

  test('Parcel should be discarded when server refuses it invalid', async () => {
    const err = new pohttp.PoHTTPInvalidParcelError('Parcel smells funny');
    getMockInstance(pohttp.deliverParcel).mockRejectedValue(err);

    await expect(postQueueEvent(event)).resolves.toBe(HTTP_STATUS_CODES.NO_CONTENT);

    expect(getContext().logs).toContainEqual(
      partialPinoLog('info', 'Parcel was rejected as invalid', {
        ...logAttributes,
        recipientInternetAddress,
        reason: err.message,
      }),
    );
  });

  test('Parcel should be discarded if server claims we violated binding', async () => {
    const err = new pohttp.PoHTTPClientBindingError('I did not understand that');
    getMockInstance(pohttp.deliverParcel).mockRejectedValue(err);

    await expect(postQueueEvent(event)).resolves.toBe(HTTP_STATUS_CODES.NO_CONTENT);

    expect(getContext().logs).toContainEqual(
      partialPinoLog('info', 'Discarding parcel due to binding issue', {
        ...logAttributes,
        recipientInternetAddress,
        reason: err.message,
      }),
    );
  });

  test('Parcel should be redelivered later if transient delivery error occurs', async () => {
    const err = new pohttp.PoHTTPError('Server is down');
    getMockInstance(pohttp.deliverParcel).mockRejectedValue(err);

    await expect(postQueueEvent(event)).resolves.toBe(HTTP_STATUS_CODES.SERVICE_UNAVAILABLE);

    expect(getContext().logs).toContainEqual(
      partialPinoLog('info', 'Failed to deliver parcel; will try again later', {
        ...logAttributes,
        err: expect.objectContaining({ type: err.name }),
        recipientInternetAddress,
      }),
    );
  });

  test('Non-PoHTTP errors should be logged as errors', async () => {
    const err = new Error('This is a bug');
    getMockInstance(pohttp.deliverParcel).mockRejectedValue(err);

    await expect(postQueueEvent(event)).resolves.toBe(HTTP_STATUS_CODES.SERVICE_UNAVAILABLE);

    expect(getContext().logs).toContainEqual(
      partialPinoLog('error', 'Failed to deliver parcel due to unexpected error', {
        ...logAttributes,
        err: expect.objectContaining({ type: err.name }),
        recipientInternetAddress,
      }),
    );
  });

  describe('TLS use', () => {
    let mockEnvVars: EnvVarMocker;
    beforeEach(() => {
      ({ envVarMocker: mockEnvVars } = getContext());
    });

    test('TLS should be used if POHTTP_USE_TLS is unset', async () => {
      mockEnvVars({ ...QUEUE_ENV_VARS, POHTTP_USE_TLS: undefined });

      await expect(postQueueEvent(event)).resolves.toBe(HTTP_STATUS_CODES.NO_CONTENT);

      expect(pohttp.deliverParcel).toBeCalledWith(expect.anything(), expect.anything(), {
        useTls: true,
      });
    });

    test('TLS should be used if POHTTP_USE_TLS is enabled', async () => {
      mockEnvVars({ ...QUEUE_ENV_VARS, POHTTP_USE_TLS: 'true' });

      await expect(postQueueEvent(event)).resolves.toBe(HTTP_STATUS_CODES.NO_CONTENT);

      expect(pohttp.deliverParcel).toBeCalledWith(expect.anything(), expect.anything(), {
        useTls: true,
      });
    });

    test('TLS should not be used if POHTTP_USE_TLS is disabled', async () => {
      mockEnvVars({ ...QUEUE_ENV_VARS, POHTTP_USE_TLS: 'false' });

      await expect(postQueueEvent(event)).resolves.toBe(HTTP_STATUS_CODES.NO_CONTENT);

      expect(pohttp.deliverParcel).toBeCalledWith(expect.anything(), expect.anything(), {
        useTls: false,
      });
    });
  });
});
