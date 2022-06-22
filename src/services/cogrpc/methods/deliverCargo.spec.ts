import * as grpc from '@grpc/grpc-js';
import { CargoDelivery, CargoDeliveryAck, CargoRelayServerMethodSet } from '@relaycorp/cogrpc';
import { Cargo, InvalidMessageError, RAMFSyntaxError } from '@relaycorp/relaynet-core';
import * as natsStreaming from '../../../backingServices/natsStreaming';
import * as certs from '../../../pki';
import { catchErrorEvent } from '../../../testUtils/errors';
import { MockGrpcBidiCall } from '../../../testUtils/grpc';
import { getMockInstance, mockSpy } from '../../../testUtils/jest';
import { partialPinoLog } from '../../../testUtils/logging';
import { generatePdaChain, PdaChain } from '../../../testUtils/pki';
import { setUpTestEnvironment, STUB_PUBLIC_ADDRESS_URL } from '../_test_utils';
import { makeServiceImplementation } from '../service';

let pdaChain: PdaChain;
let privateGatewayAddress: string;
beforeAll(async () => {
  pdaChain = await generatePdaChain();
  privateGatewayAddress = await pdaChain.privateGatewayCert.calculateSubjectPrivateAddress();
});

const { getSvcImplOptions, getMockLogs } = setUpTestEnvironment();

const DELIVERY_ID = 'the-id';

let CARGO: Cargo;
let CARGO_SERIALIZATION: Buffer;
beforeAll(async () => {
  CARGO = new Cargo(STUB_PUBLIC_ADDRESS_URL, pdaChain.privateGatewayCert, Buffer.from('payload'));
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

const RETRIEVE_OWN_CERTIFICATES_SPY = mockSpy(jest.spyOn(certs, 'retrieveOwnCertificates'), () => [
  pdaChain.publicGatewayCert,
]);

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

  test('Errors while processing cargo should be logged and end the call', async () => {
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

    const callError = await catchErrorEvent(CALL, () =>
      SERVICE.deliverCargo(CALL.convertToGrpcStream()),
    );

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
  });

  test('No ACK should be sent if a valid cargo cannot be queued', async () => {
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

    await catchErrorEvent(CALL, () => SERVICE.deliverCargo(CALL.convertToGrpcStream()));

    expect(CALL.write).toBeCalledTimes(1);
    expect(CALL.write).toBeCalledWith({ id: DELIVERY_ID });
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
