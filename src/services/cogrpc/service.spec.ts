/* tslint:disable:no-let */

import { CargoDelivery, CargoDeliveryAck } from '@relaycorp/relaynet-cogrpc';
import { Cargo } from '@relaycorp/relaynet-core';
import { mongoose } from '@typegoose/typegoose';
import { ServerDuplexStream } from 'grpc';
import { Duplex } from 'stream';

import { getMockContext, makeEmptyCertificate, mockSpy } from '../_test_utils';
import * as certs from '../certs';
import * as natsStreaming from '../natsStreaming';
import { collectCargo, makeServiceImplementation } from './service';

const STUB_DELIVERY_ID = 'the-id';
const STUB_CARGO_SERIALIZATION = Buffer.from('Pretend this is a valid cargo');

const STUB_CARGO = new Cargo('0123', makeEmptyCertificate(), Buffer.from('payload'));

const STUB_TRUSTED_CERTIFICATE = makeEmptyCertificate();

const STUB_MONGO_URI = 'mongo://example.com';

const STUB_NATS_SERVER_URL = 'nats://example.com';
const STUB_NATS_CLUSTER_ID = 'nats-cluster-id';
let mockNatsClient: natsStreaming.NatsStreamingClient;
// tslint:disable-next-line:readonly-array
let natsPublishedMessages: Buffer[];
beforeEach(() => {
  natsPublishedMessages = [];
  async function* mockNatsPublisher(
    messages: IterableIterator<natsStreaming.PublisherMessage>,
  ): AsyncIterable<string> {
    for await (const message of messages) {
      natsPublishedMessages.push(message.data);
      yield message.id;
    }
  }
  mockNatsClient = ({
    disconnect: jest.fn(),
    makePublisher: jest.fn().mockReturnValue(mockNatsPublisher),
  } as unknown) as natsStreaming.NatsStreamingClient;
});
const mockNatsClientClass = mockSpy(
  jest.spyOn(natsStreaming, 'NatsStreamingClient'),
  () => mockNatsClient,
);

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

  const { deliverCargo } = makeServiceImplementation({
    mongoUri: STUB_MONGO_URI,
    natsClusterId: STUB_NATS_CLUSTER_ID,
    natsServerUrl: STUB_NATS_SERVER_URL,
  });

  describe('deliverCargo', () => {
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

    test('NATS Streaming publisher should be initialized upfront', async () => {
      expect(mockNatsClientClass).not.toBeCalled();

      await deliverCargo(mockDuplexStream.convertToGrpcStream());

      expect(mockNatsClientClass).toBeCalledTimes(1);
      expect(mockNatsClientClass).toBeCalledWith(
        STUB_NATS_SERVER_URL,
        STUB_NATS_CLUSTER_ID,
        expect.stringMatching(/^cogrpc-([a-f0-9]+-){4}[a-f0-9]+$/),
      );
      expect(mockNatsClient.makePublisher).toBeCalledTimes(1);
      expect(mockNatsClient.makePublisher).toBeCalledWith('crc-cargo');
    });

    describe('Cargo processing', () => {
      const cargoDeserializeSpy = mockSpy(jest.spyOn(Cargo, 'deserialize'), () => STUB_CARGO);
      const cargoValidateSpy = mockSpy(jest.spyOn(STUB_CARGO, 'validate'));

      test('Malformed message should be ACKd but discarded', async () => {
        // The invalid message is followed by a valid one to check that processing continues
        cargoDeserializeSpy.mockReset();
        cargoDeserializeSpy.mockRejectedValueOnce(new Error('Denied'));
        cargoDeserializeSpy.mockResolvedValueOnce(STUB_CARGO);

        const invalidDeliveryId = 'invalid';
        mockDuplexStream.output.push(
          { cargo: Buffer.from('invalid cargo'), id: invalidDeliveryId },
          {
            cargo: STUB_CARGO_SERIALIZATION,
            id: STUB_DELIVERY_ID,
          },
        );
        await deliverCargo(mockDuplexStream.convertToGrpcStream());

        expect(mockDuplexStream.write).toBeCalledTimes(2);
        expect(mockDuplexStream.write).toBeCalledWith({ id: invalidDeliveryId });
        expect(mockDuplexStream.write).toBeCalledWith({ id: STUB_DELIVERY_ID });

        expect(natsPublishedMessages).toEqual([STUB_CARGO_SERIALIZATION]);
      });

      test('Well-formed yet invalid message should be ACKd but discarded', async () => {
        // The invalid message is followed by a valid one to check that processing continues
        cargoValidateSpy.mockReset();
        cargoValidateSpy.mockRejectedValueOnce(new Error('Denied'));
        cargoValidateSpy.mockResolvedValueOnce(undefined);
        const invalidDeliveryId = 'invalid';
        mockDuplexStream.output.push(
          { cargo: Buffer.from('invalid cargo'), id: invalidDeliveryId },
          {
            cargo: STUB_CARGO_SERIALIZATION,
            id: STUB_DELIVERY_ID,
          },
        );

        await deliverCargo(mockDuplexStream.convertToGrpcStream());

        expect(mockDuplexStream.write).toBeCalledTimes(2);
        expect(mockDuplexStream.write).toBeCalledWith({ id: invalidDeliveryId });
        expect(mockDuplexStream.write).toBeCalledWith({ id: STUB_DELIVERY_ID });

        expect(natsPublishedMessages).toEqual([STUB_CARGO_SERIALIZATION]);
      });

      test('Valid message should be ACKd and added to queue', async () => {
        mockDuplexStream.output.push({
          cargo: STUB_CARGO_SERIALIZATION,
          id: STUB_DELIVERY_ID,
        });

        await deliverCargo(mockDuplexStream.convertToGrpcStream());

        expect(natsPublishedMessages).toEqual([STUB_CARGO_SERIALIZATION]);

        expect(mockDuplexStream.write).toBeCalledTimes(1);
        expect(mockDuplexStream.write).toBeCalledWith({ id: STUB_DELIVERY_ID });
      });

      test('No ACK should be sent if a valid cargo cannot be queued', async () => {
        // Receive two deliveries. The first succeeds but the second fails.

        const error = new Error('Denied');
        async function* publishFirstMessageThenFail(
          messages: IterableIterator<natsStreaming.PublisherMessage>,
        ): AsyncIterable<string> {
          let firstMessageYielded = false;
          for await (const message of messages) {
            if (!firstMessageYielded) {
              yield message.id;
              firstMessageYielded = true;
              continue;
            }
            throw error;
          }
        }
        ((mockNatsClient.makePublisher as unknown) as jest.MockInstance<any, any>).mockReturnValue(
          publishFirstMessageThenFail,
        );
        const undeliveredMessageId = 'undelivered';
        mockDuplexStream.output.push(
          {
            cargo: STUB_CARGO_SERIALIZATION,
            id: STUB_DELIVERY_ID,
          },
          {
            cargo: STUB_CARGO_SERIALIZATION,
            id: undeliveredMessageId,
          },
        );

        await expect(deliverCargo(mockDuplexStream.convertToGrpcStream())).rejects.toEqual(error);

        expect(mockDuplexStream.write).toBeCalledTimes(1);
        expect(mockDuplexStream.write).toBeCalledWith({ id: STUB_DELIVERY_ID });

        // TODO: Log error message
      });

      test('NATS Streaming connection should be closed upon completion', async () => {
        mockDuplexStream.output.push({
          cargo: STUB_CARGO_SERIALIZATION,
          id: STUB_DELIVERY_ID,
        });

        await deliverCargo(mockDuplexStream.convertToGrpcStream());

        expect(mockNatsClient.disconnect).toBeCalledTimes(1);
      });

      test('NATS Streaming connection should be closed upon error', async () => {
        async function* throwError(
          messages: AsyncIterable<natsStreaming.PublisherMessage>,
        ): AsyncIterable<string> {
          for await (const message of messages) {
            yield message.id;
          }
          throw new Error('Denied');
        }
        ((mockNatsClient.makePublisher as unknown) as jest.MockInstance<any, any>).mockReturnValue(
          throwError,
        );
        mockDuplexStream.output.push({
          cargo: STUB_CARGO_SERIALIZATION,
          id: STUB_DELIVERY_ID,
        });

        await expect(deliverCargo(mockDuplexStream.convertToGrpcStream())).toReject();

        expect(mockNatsClient.disconnect).toBeCalledTimes(1);
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
