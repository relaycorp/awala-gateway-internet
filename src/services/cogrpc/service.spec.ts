import * as grpc from '@grpc/grpc-js';
import { CargoDelivery, CargoDeliveryAck, CargoRelayServerMethodSet } from '@relaycorp/cogrpc';
import { Cargo, InvalidMessageError, RAMFSyntaxError } from '@relaycorp/relaynet-core';
import { EventEmitter } from 'events';

import { mockSpy, partialPinoLog, PdaChain } from '../../_test_utils';
import * as natsStreaming from '../../backingServices/natsStreaming';
import * as certs from '../../certs';
import { generatePdaChain, getMockInstance } from '../_test_utils';
import { MockGrpcBidiCall, setUpTestEnvironment } from './_test_utils';
import { makeServiceImplementation } from './service';

let pdaChain: PdaChain;
let privateGatewayAddress: string;
beforeAll(async () => {
  pdaChain = await generatePdaChain();
  privateGatewayAddress = await pdaChain.privateGatewayCert.calculateSubjectPrivateAddress();
});

const { getSvcImplOptions, getMockLogs } = setUpTestEnvironment();

describe('makeServiceImplementation', () => {
  describe('Mongoose connection', () => {
    test('Connection should be created preemptively before any RPC', async () => {
      expect(getSvcImplOptions().getMongooseConnection).not.toBeCalled();

      await makeServiceImplementation(getSvcImplOptions());

      expect(getSvcImplOptions().getMongooseConnection).toBeCalled();
    });

    test('Errors while establishing connection should be propagated', async () => {
      const error = new Error('Database credentials are wrong');
      getMockInstance(getSvcImplOptions().getMongooseConnection).mockRejectedValue(error);

      await expect(makeServiceImplementation(getSvcImplOptions())).rejects.toEqual(error);
    });

    test('Errors after establishing connection should be logged', async (cb) => {
      const mockConnection = new EventEmitter();
      getMockInstance(getSvcImplOptions().getMongooseConnection).mockResolvedValue(mockConnection);
      await makeServiceImplementation(getSvcImplOptions());

      const error = new Error('Database credentials are wrong');

      mockConnection.on('error', (err) => {
        expect(getMockLogs()).toContainEqual(
          partialPinoLog('error', 'Mongoose connection error', {
            err: expect.objectContaining({ message: err.message }),
          }),
        );
        cb();
      });
      mockConnection.emit('error', error);
    });
  });
});

describe('deliverCargo', () => {
  const DELIVERY_ID = 'the-id';

  let CARGO: Cargo;
  let CARGO_SERIALIZATION: Buffer;
  beforeAll(async () => {
    const publicAddressURL = `https://${getSvcImplOptions().publicAddress}`;
    CARGO = new Cargo(publicAddressURL, pdaChain.privateGatewayCert, Buffer.from('payload'));
    CARGO_SERIALIZATION = Buffer.from(await CARGO.serialize(pdaChain.privateGatewayPrivateKey));
  });

  let NATS_CLIENT: natsStreaming.NatsStreamingClient;
  // tslint:disable-next-line:readonly-array
  let PUBLISHED_MESSAGES: Buffer[];
  beforeEach(() => {
    PUBLISHED_MESSAGES = [];

    async function* mockNatsPublisher(
      messages: IterableIterator<natsStreaming.PublisherMessage>,
    ): AsyncIterable<string> {
      for await (const message of messages) {
        PUBLISHED_MESSAGES.push(message.data as Buffer);
        yield message.id;
      }
    }

    NATS_CLIENT = {
      makePublisher: jest.fn().mockReturnValue(mockNatsPublisher),
    } as unknown as natsStreaming.NatsStreamingClient;
  });
  const mockNatsClientClass = mockSpy(
    jest.spyOn(natsStreaming, 'NatsStreamingClient'),
    () => NATS_CLIENT,
  );

  let SERVICE: CargoRelayServerMethodSet;
  beforeEach(async () => {
    SERVICE = await makeServiceImplementation(getSvcImplOptions());
  });

  let CALL: MockGrpcBidiCall<CargoDeliveryAck, CargoDelivery>;
  beforeEach(() => {
    CALL = new MockGrpcBidiCall();
  });

  const RETRIEVE_OWN_CERTIFICATES_SPY = mockSpy(
    jest.spyOn(certs, 'retrieveOwnCertificates'),
    () => [pdaChain.publicGatewayCert],
  );

  test('NATS Streaming publisher should be initialized upfront', async () => {
    expect(mockNatsClientClass).not.toBeCalled();

    await SERVICE.deliverCargo(CALL.convertToGrpcStream());

    expect(mockNatsClientClass).toBeCalledTimes(1);
    expect(mockNatsClientClass).toBeCalledWith(
      getSvcImplOptions().natsServerUrl,
      getSvcImplOptions().natsClusterId,
      expect.stringMatching(/^cogrpc-([a-f0-9]+-){4}[a-f0-9]+$/),
    );
    expect(NATS_CLIENT.makePublisher).toBeCalledTimes(1);
    expect(NATS_CLIENT.makePublisher).toBeCalledWith('crc-cargo');
  });

  describe('Cargo processing', () => {
    test('Malformed message should be ACKd but discarded', async () => {
      // The invalid message is followed by a valid one to check that processing continues
      const invalidDeliveryId = 'invalid';
      CALL.output.push(
        { cargo: Buffer.from('invalid cargo'), id: invalidDeliveryId },
        {
          cargo: CARGO_SERIALIZATION,
          id: DELIVERY_ID,
        },
      );
      await SERVICE.deliverCargo(CALL.convertToGrpcStream());

      expect(CALL.write).toBeCalledTimes(2);
      expect(CALL.write).toBeCalledWith({ id: invalidDeliveryId });
      expect(CALL.write).toBeCalledWith({ id: DELIVERY_ID });

      expect(PUBLISHED_MESSAGES).toEqual([CARGO_SERIALIZATION]);

      expect(getMockLogs()).toContainEqual(
        partialPinoLog('info', 'Ignoring malformed/invalid cargo', {
          err: expect.objectContaining({ type: RAMFSyntaxError.name }),
          grpcClient: CALL.getPeer(),
          grpcMethod: 'deliverCargo',
          peerGatewayAddress: null,
        }),
      );
    });

    test('Well-formed yet invalid message should be ACKd but discarded', async () => {
      // The invalid message is followed by a valid one to check that processing continues
      const invalidCargo = new Cargo(
        `https://${getSvcImplOptions().publicAddress}`,
        pdaChain.peerEndpointCert,
        Buffer.from('payload'),
      );
      const invalidCargoSerialized = await invalidCargo.serialize(pdaChain.peerEndpointPrivateKey);
      const invalidDeliveryId = 'invalid';
      CALL.output.push(
        { cargo: Buffer.from(invalidCargoSerialized), id: invalidDeliveryId },
        {
          cargo: CARGO_SERIALIZATION,
          id: DELIVERY_ID,
        },
      );

      await SERVICE.deliverCargo(CALL.convertToGrpcStream());

      expect(CALL.write).toBeCalledTimes(2);
      expect(CALL.write).toBeCalledWith({ id: invalidDeliveryId });
      expect(CALL.write).toBeCalledWith({ id: DELIVERY_ID });

      expect(PUBLISHED_MESSAGES).toEqual([CARGO_SERIALIZATION]);

      expect(getMockLogs()).toContainEqual(
        partialPinoLog('info', 'Ignoring malformed/invalid cargo', {
          err: expect.objectContaining({ type: InvalidMessageError.name }),
          grpcClient: CALL.getPeer(),
          grpcMethod: 'deliverCargo',
          peerGatewayAddress: await invalidCargo.senderCertificate.calculateSubjectPrivateAddress(),
        }),
      );
    });

    test('Valid message should be ACKd and added to queue', async () => {
      CALL.output.push({
        cargo: CARGO_SERIALIZATION,
        id: DELIVERY_ID,
      });

      await SERVICE.deliverCargo(CALL.convertToGrpcStream());

      expect(PUBLISHED_MESSAGES).toEqual([CARGO_SERIALIZATION]);

      expect(CALL.write).toBeCalledTimes(1);
      expect(CALL.write).toBeCalledWith({ id: DELIVERY_ID });

      expect(getMockLogs()).toContainEqual(
        partialPinoLog('info', 'Processing valid cargo', {
          cargoId: CARGO.id,
          grpcClient: CALL.getPeer(),
          grpcMethod: 'deliverCargo',
          peerGatewayAddress: privateGatewayAddress,
        }),
      );
    });

    test('Successful completion should be logged and end the call', async () => {
      CALL.output.push({
        cargo: CARGO_SERIALIZATION,
        id: DELIVERY_ID,
      });

      await SERVICE.deliverCargo(CALL.convertToGrpcStream());

      expect(getMockLogs()).toContainEqual(
        partialPinoLog('info', 'Cargo delivery completed successfully', {
          cargoesDelivered: 1,
          grpcClient: CALL.getPeer(),
          grpcMethod: 'deliverCargo',
        }),
      );
      expect(CALL.end).toBeCalledWith();
    });

    test('Errors while processing cargo should be logged and end the call', async (cb) => {
      const error = new Error('Denied');

      async function* failToPublishMessage(
        _: IterableIterator<natsStreaming.PublisherMessage>,
      ): AsyncIterable<string> {
        throw error;
      }

      getMockInstance(NATS_CLIENT.makePublisher).mockReturnValue(failToPublishMessage);
      CALL.output.push({
        cargo: CARGO_SERIALIZATION,
        id: DELIVERY_ID,
      });

      CALL.on('error', async (callError) => {
        expect(getMockLogs()).toContainEqual(
          partialPinoLog('error', 'Failed to store cargo', {
            err: expect.objectContaining({ message: error.message }),
            grpcClient: CALL.getPeer(),
            grpcMethod: 'deliverCargo',
          }),
        );

        expect(callError).toEqual({
          code: grpc.status.UNAVAILABLE,
          message: 'Internal server error; please try again later',
        });

        expect(CALL.end).toBeCalledWith();

        cb();
      });

      await SERVICE.deliverCargo(CALL.convertToGrpcStream());
    });

    test('No ACK should be sent if a valid cargo cannot be queued', async (cb) => {
      // Receive two deliveries. The first succeeds but the second fails.

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
          throw new Error('Denied');
        }
      }

      getMockInstance(NATS_CLIENT.makePublisher).mockReturnValue(publishFirstMessageThenFail);
      const undeliveredMessageId = 'undelivered';
      CALL.output.push(
        {
          cargo: CARGO_SERIALIZATION,
          id: DELIVERY_ID,
        },
        {
          cargo: CARGO_SERIALIZATION,
          id: undeliveredMessageId,
        },
      );

      CALL.on('error', async () => {
        expect(CALL.write).toBeCalledTimes(1);
        expect(CALL.write).toBeCalledWith({ id: DELIVERY_ID });

        cb();
      });

      await SERVICE.deliverCargo(CALL.convertToGrpcStream());
    });

    test('Trusted certificates should be retrieved once in the lifetime of the call', async () => {
      // Even if multiple cargoes are received
      CALL.output.push(
        {
          cargo: CARGO_SERIALIZATION,
          id: `${DELIVERY_ID}-1`,
        },
        {
          cargo: CARGO_SERIALIZATION,
          id: `${DELIVERY_ID}-2`,
        },
      );
      await SERVICE.deliverCargo(CALL.convertToGrpcStream());

      expect(RETRIEVE_OWN_CERTIFICATES_SPY).toBeCalledTimes(1);
    });
  });
});
