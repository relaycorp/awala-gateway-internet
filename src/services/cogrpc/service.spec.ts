/* tslint:disable:no-let */

import { CargoDelivery, CargoDeliveryAck } from '@relaycorp/relaynet-cogrpc';
import { Cargo } from '@relaycorp/relaynet-core';
import { mongoose } from '@typegoose/typegoose';
import { EventEmitter } from 'events';
import { ServerDuplexStream } from 'grpc';

import { getMockContext, makeEmptyCertificate, mockSpy } from '../_test_utils';
import * as certs from '../certs';
import * as nats from '../nats';
import { collectCargo, makeServiceImplementation } from './service';

const STUB_DELIVERY_ID = 'the-id';
const STUB_CARGO_SERIALIZATION = Buffer.from('Pretend this is a valid cargo');

const STUB_CARGO = new Cargo('0123', makeEmptyCertificate(), Buffer.from('payload'));

const STUB_TRUSTED_CERTIFICATE = makeEmptyCertificate();

const STUB_MONGO_URI = 'mongo://example.com';

describe('service', () => {
  let mockMongooseConnection: mongoose.Connection;
  beforeEach(() => {
    mockMongooseConnection = ({
      close: jest.fn(),
    } as unknown) as mongoose.Connection;
  });
  const mockMongooseCreateConnection = mockSpy(
    jest.spyOn(mongoose, 'createConnection'),
    () => mockMongooseConnection,
  );

  let mockServerDuplexStream: ServerDuplexStream<any, any>;
  beforeEach(() => {
    const eventEmitter = new EventEmitter();
    mockServerDuplexStream = ({
      emit: jest
        .fn()
        .mockImplementation((event: string, ...args: readonly any[]) =>
          eventEmitter.emit(event, ...args),
        ),
      end: jest.fn(),
      on: jest
        .fn()
        .mockImplementation((event: string, cb: (data: any) => void) => eventEmitter.on(event, cb)),
      write: jest.fn(),
    } as unknown) as ServerDuplexStream<any, any>;
  });

  describe('deliverCargo', () => {
    const { deliverCargo } = makeServiceImplementation({ mongoUri: STUB_MONGO_URI });
    const retrieveOwnCertificatesSpy = mockSpy(jest.spyOn(certs, 'retrieveOwnCertificates'), () => [
      STUB_TRUSTED_CERTIFICATE,
    ]);

    test('Mongoose connection should be initialized and closed upfront', async () => {
      expect(mockMongooseCreateConnection).not.toBeCalled();

      await deliverCargo(mockServerDuplexStream);

      expect(mockMongooseCreateConnection).toBeCalledTimes(1);
      expect(mockMongooseCreateConnection).toBeCalledWith(STUB_MONGO_URI);
      expect(mockMongooseConnection.close).toBeCalledTimes(1);
    });

    describe('Cargo processing', () => {
      const natsPublishMessageSpy = mockSpy(jest.spyOn(nats, 'publishMessage'));
      const cargoDeserializeSpy = mockSpy(jest.spyOn(Cargo, 'deserialize'), () => STUB_CARGO);
      const cargoValidateSpy = mockSpy(jest.spyOn(STUB_CARGO, 'validate'));

      let dataCallback: (delivery: CargoDelivery) => void;
      beforeEach(async () => {
        await deliverCargo(mockServerDuplexStream);

        const onDataCalls = getMockContext(mockServerDuplexStream.on).calls.filter(
          c => c[0] === 'data',
        );
        expect(onDataCalls).toHaveLength(1);
        dataCallback = onDataCalls[0][1];
      });

      test('Malformed message should be ACKd but discarded', async () => {
        const error = new Error('Denied');
        cargoDeserializeSpy.mockRejectedValueOnce(error);

        await dataCallback({ id: STUB_DELIVERY_ID, cargo: STUB_CARGO_SERIALIZATION });

        expect(cargoDeserializeSpy).toBeCalledTimes(1);
        expect(cargoDeserializeSpy).toBeCalledWith(STUB_CARGO_SERIALIZATION);

        expect(mockServerDuplexStream.write).toBeCalledTimes(1);
        expect(mockServerDuplexStream.write).toBeCalledWith({ id: STUB_DELIVERY_ID });

        expect(natsPublishMessageSpy).not.toBeCalled();
      });

      test('Well-formed yet invalid message should be ACKd but discarded', async () => {
        const error = new Error('Denied');
        cargoValidateSpy.mockRejectedValueOnce(error);

        await dataCallback({ id: STUB_DELIVERY_ID, cargo: STUB_CARGO_SERIALIZATION });

        expect(cargoValidateSpy).toBeCalledTimes(1);
        expect(cargoValidateSpy).toBeCalledWith([STUB_TRUSTED_CERTIFICATE]);

        expect(mockServerDuplexStream.write).toBeCalledTimes(1);
        expect(mockServerDuplexStream.write).toBeCalledWith({ id: STUB_DELIVERY_ID });

        expect(natsPublishMessageSpy).not.toBeCalled();
      });

      test('Valid message should be ACKd and added to queue', async () => {
        await dataCallback({ id: STUB_DELIVERY_ID, cargo: STUB_CARGO_SERIALIZATION });

        expect(natsPublishMessageSpy).toBeCalledTimes(1);
        expect(natsPublishMessageSpy).toBeCalledWith(STUB_CARGO_SERIALIZATION, 'crc-cargo');

        expect(mockServerDuplexStream.write).toBeCalledTimes(1);
        expect(mockServerDuplexStream.write).toBeCalledWith({ id: STUB_DELIVERY_ID });
      });

      test('No ACK should be sent if a valid cargo cannot be queued', async () => {
        const error = new Error('Denied');
        natsPublishMessageSpy.mockRejectedValueOnce(error);
        await dataCallback({ id: STUB_DELIVERY_ID, cargo: STUB_CARGO_SERIALIZATION });

        expect(mockServerDuplexStream.write).not.toBeCalled();

        // TODO: Log error message
      });

      test('Trusted certificates should be retrieved once in the lifetime of the call', async () => {
        // Even if multiple cargoes are received
        await dataCallback({ id: `${STUB_DELIVERY_ID}-1`, cargo: STUB_CARGO_SERIALIZATION });
        await dataCallback({ id: `${STUB_DELIVERY_ID}-2`, cargo: STUB_CARGO_SERIALIZATION });

        expect(retrieveOwnCertificatesSpy).toBeCalledTimes(1);
      });
    });

    test('Call should end when client attempts to end connection', async () => {
      await deliverCargo(mockServerDuplexStream);
      expect(mockServerDuplexStream.on).toBeCalledWith('end', expect.anything());
      expect(mockServerDuplexStream.end).not.toBeCalled();

      mockServerDuplexStream.emit('end');

      expect(mockServerDuplexStream.end).toBeCalledTimes(1);
    });
  });

  describe('collectCargo', () => {
    test('Unimplemented', async () => {
      await expect(
        collectCargo((null as unknown) as ServerDuplexStream<CargoDeliveryAck, CargoDelivery>),
      ).rejects.toEqual(new Error('Unimplemented'));
    });
  });
});
