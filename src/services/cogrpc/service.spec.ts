/* tslint:disable:no-let */

import { CargoDelivery, CargoDeliveryAck } from '@relaycorp/relaynet-cogrpc';
import { Cargo } from '@relaycorp/relaynet-core';
import { mongoose } from '@typegoose/typegoose';
import { ServerDuplexStream } from 'grpc';
import { Duplex } from 'stream';

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

  let mockDuplexStream: RecordingStream<CargoDeliveryAck, CargoDelivery>;
  beforeEach(() => {
    mockDuplexStream = new RecordingStream();
    jest.spyOn(mockDuplexStream, 'on');
    jest.spyOn(mockDuplexStream, 'end');
    jest.spyOn(mockDuplexStream, 'write');
  });

  describe('deliverCargo', () => {
    const { deliverCargo } = makeServiceImplementation({ mongoUri: STUB_MONGO_URI });
    const retrieveOwnCertificatesSpy = mockSpy(jest.spyOn(certs, 'retrieveOwnCertificates'), () => [
      STUB_TRUSTED_CERTIFICATE,
    ]);

    test('Mongoose connection should be initialized and closed upfront', async () => {
      expect(mockMongooseCreateConnection).not.toBeCalled();

      await deliverCargo(mockDuplexStream.convertToGrpcStream());

      expect(mockMongooseCreateConnection).toBeCalledTimes(1);
      expect(mockMongooseCreateConnection).toBeCalledWith(STUB_MONGO_URI);
      expect(mockMongooseConnection.close).toBeCalledTimes(1);
    });

    describe('Cargo processing', () => {
      const natsPublishMessageSpy = mockSpy(jest.spyOn(nats, 'publishMessage'), () => undefined);
      const cargoDeserializeSpy = mockSpy(jest.spyOn(Cargo, 'deserialize'), () => STUB_CARGO);
      const cargoValidateSpy = mockSpy(jest.spyOn(STUB_CARGO, 'validate'));

      test('Malformed message should be ACKd but discarded', async () => {
        const error = new Error('Denied');
        cargoDeserializeSpy.mockRejectedValueOnce(error);

        mockDuplexStream.output.push({
          cargo: STUB_CARGO_SERIALIZATION,
          id: STUB_DELIVERY_ID,
        });
        await deliverCargo(mockDuplexStream.convertToGrpcStream());

        expect(cargoDeserializeSpy).toBeCalledTimes(1);
        expect(cargoDeserializeSpy).toBeCalledWith(STUB_CARGO_SERIALIZATION);

        expect(mockDuplexStream.write).toBeCalledTimes(1);
        expect(mockDuplexStream.write).toBeCalledWith({ id: STUB_DELIVERY_ID });

        expect(natsPublishMessageSpy).not.toBeCalled();
      });

      test('Well-formed yet invalid message should be ACKd but discarded', async () => {
        const error = new Error('Denied');
        cargoValidateSpy.mockRejectedValueOnce(error);

        mockDuplexStream.output.push({
          cargo: STUB_CARGO_SERIALIZATION,
          id: STUB_DELIVERY_ID,
        });

        await deliverCargo(mockDuplexStream.convertToGrpcStream());

        expect(cargoValidateSpy).toBeCalledTimes(1);
        expect(cargoValidateSpy).toBeCalledWith([STUB_TRUSTED_CERTIFICATE]);

        expect(mockDuplexStream.write).toBeCalledTimes(1);
        expect(mockDuplexStream.write).toBeCalledWith({ id: STUB_DELIVERY_ID });

        expect(natsPublishMessageSpy).not.toBeCalled();
      });

      test('Valid message should be ACKd and added to queue', async () => {
        mockDuplexStream.output.push({
          cargo: STUB_CARGO_SERIALIZATION,
          id: STUB_DELIVERY_ID,
        });

        await deliverCargo(mockDuplexStream.convertToGrpcStream());

        expect(nats.publishMessage).toBeCalledTimes(1);
        expect(nats.publishMessage).toBeCalledWith(STUB_CARGO_SERIALIZATION, 'crc-cargo');

        expect(mockDuplexStream.write).toBeCalledTimes(1);
        expect(mockDuplexStream.write).toBeCalledWith({ id: STUB_DELIVERY_ID });
      });

      test('No ACK should be sent if a valid cargo cannot be queued', async () => {
        const error = new Error('Denied');
        natsPublishMessageSpy.mockRejectedValueOnce(error);
        mockDuplexStream.output.push({
          cargo: STUB_CARGO_SERIALIZATION,
          id: STUB_DELIVERY_ID,
        });

        await deliverCargo(mockDuplexStream.convertToGrpcStream());

        expect(mockDuplexStream.write).not.toBeCalled();

        // TODO: Log error message
      });

      test('Trusted certificates should be retrieved once in the lifetime of the call', async () => {
        // Even if multiple cargoes are received
        mockDuplexStream.output.push(
          {
            cargo: STUB_CARGO_SERIALIZATION,
            id: `${STUB_DELIVERY_ID}-1`,
          },
          {
            cargo: STUB_CARGO_SERIALIZATION,
            id: `${STUB_DELIVERY_ID}-2`,
          },
        );
        await deliverCargo(mockDuplexStream.convertToGrpcStream());

        expect(retrieveOwnCertificatesSpy).toBeCalledTimes(1);
      });
    });

    test('Call should end when client attempts to end connection', async () => {
      await deliverCargo(mockDuplexStream.convertToGrpcStream());
      expect(mockDuplexStream.on).toBeCalledWith('end', expect.any(Function));
      const endCallback = getMockContext(mockDuplexStream.on).calls[0][1];

      expect(mockDuplexStream.end).toBeCalledTimes(1);
      endCallback();
      expect(mockDuplexStream.end).toBeCalledTimes(2);
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

class RecordingStream<Input, Output> extends Duplex {
  // tslint:disable-next-line:readonly-array readonly-keyword
  public input: Input[] = [];
  // tslint:disable-next-line:readonly-array readonly-keyword
  public output: Output[] = [];

  constructor() {
    super({ objectMode: true });
  }

  public _read(_size: number): void {
    while (this.output.length) {
      const canPushAgain = this.push(this.output.shift());
      if (!canPushAgain) {
        return;
      }
    }

    this.push(null);
  }

  public _write(value: Input, _encoding: string, callback: (error?: Error) => void): void {
    this.input.push(value);
    callback();
  }

  public convertToGrpcStream(): ServerDuplexStream<Input, Output> {
    // Unfortunately, ServerDuplexStream's constructor is private so we have to ressort to this
    // ugly hack
    return (this as unknown) as ServerDuplexStream<Input, Output>;
  }
}
