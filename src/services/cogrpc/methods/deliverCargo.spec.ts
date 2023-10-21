import * as grpc from '@grpc/grpc-js';
import { CargoDelivery, CargoDeliveryAck, CargoRelayServerMethodSet } from '@relaycorp/cogrpc';
import { Cargo, InvalidMessageError, RAMFSyntaxError } from '@relaycorp/relaynet-core';

import * as certs from '../../../pki';
import { GATEWAY_INTERNET_ADDRESS } from '../../../testUtils/awala';
import { catchErrorEvent } from '../../../testUtils/errors';
import { MockGrpcBidiCall } from '../../../testUtils/grpc';
import { mockSpy } from '../../../testUtils/jest';
import { partialPinoLog } from '../../../testUtils/logging';
import { generatePdaChain, PdaChain } from '../../../testUtils/pki';
import { setUpTestEnvironment } from '../_test_utils';
import { makeService } from '../service';
import { EVENT_TYPES } from '../../queue/sinks/types';

let pdaChain: PdaChain;
let privateGatewayId: string;
beforeAll(async () => {
  pdaChain = await generatePdaChain();
  privateGatewayId = await pdaChain.privateGatewayCert.calculateSubjectId();
});

const { getSvcImplOptions, getMockLogs, queueEmitter } = setUpTestEnvironment();

const DELIVERY_ID = 'the-id';

let cargo: Cargo;
let cargoSerialization: Buffer;
beforeAll(async () => {
  cargo = new Cargo(
    {
      id: await pdaChain.internetGatewayCert.calculateSubjectId(),
      internetAddress: GATEWAY_INTERNET_ADDRESS,
    },
    pdaChain.privateGatewayCert,
    Buffer.from('payload'),
  );
  cargoSerialization = Buffer.from(await cargo.serialize(pdaChain.privateGatewayPrivateKey));
});

let SERVICE: CargoRelayServerMethodSet;
beforeEach(async () => {
  SERVICE = await makeService(getSvcImplOptions());
});

let CALL: MockGrpcBidiCall<CargoDeliveryAck, CargoDelivery>;
beforeEach(() => {
  CALL = new MockGrpcBidiCall();
});

const RETRIEVE_OWN_CERTIFICATES_SPY = mockSpy(jest.spyOn(certs, 'retrieveOwnCertificates'), () => [
  pdaChain.internetGatewayCert,
]);

describe('Cargo processing', () => {
  test('Malformed message should be ACKd but discarded', async () => {
    CALL.output.push({ cargo: Buffer.from('invalid cargo'), id: DELIVERY_ID });

    await SERVICE.deliverCargo(CALL.convertToGrpcStream());

    expect(CALL.write).toBeCalledTimes(1);
    expect(CALL.write).toBeCalledWith({ id: DELIVERY_ID });

    expect(queueEmitter.events).toHaveLength(0);

    expect(getMockLogs()).toContainEqual(
      partialPinoLog('info', 'Ignoring malformed/invalid cargo', {
        err: expect.objectContaining({ type: RAMFSyntaxError.name }),
        grpcClient: CALL.getPeer(),
        grpcMethod: 'deliverCargo',
        privatePeerId: null,
      }),
    );
  });

  test('Well-formed yet invalid message should be ACKd but discarded', async () => {
    const invalidCargo = new Cargo(
      cargo.recipient,
      pdaChain.peerEndpointCert,
      Buffer.from('payload'),
    );
    const invalidCargoSerialized = await invalidCargo.serialize(pdaChain.peerEndpointPrivateKey);
    CALL.output.push({ cargo: Buffer.from(invalidCargoSerialized), id: DELIVERY_ID });

    await SERVICE.deliverCargo(CALL.convertToGrpcStream());

    expect(CALL.write).toBeCalledTimes(1);
    expect(CALL.write).toBeCalledWith({ id: DELIVERY_ID });

    expect(queueEmitter.events).toHaveLength(0);

    expect(getMockLogs()).toContainEqual(
      partialPinoLog('info', 'Ignoring malformed/invalid cargo', {
        err: expect.objectContaining({ type: InvalidMessageError.name }),
        grpcClient: CALL.getPeer(),
        grpcMethod: 'deliverCargo',
        privatePeerId: await invalidCargo.senderCertificate.calculateSubjectId(),
      }),
    );
  });

  test('Valid message should be ACKd and added to queue', async () => {
    CALL.output.push({
      cargo: cargoSerialization,
      id: DELIVERY_ID,
    });

    await SERVICE.deliverCargo(CALL.convertToGrpcStream());

    expect(CALL.write).toBeCalledTimes(1);
    expect(CALL.write).toBeCalledWith({ id: DELIVERY_ID });

    expect(queueEmitter.events).toHaveLength(1);
    const [event] = queueEmitter.events;
    expect(event.type).toEqual(EVENT_TYPES.CRC_INCOMING_CARGO);
    expect(event.source).toEqual(privateGatewayId);
    expect(event.subject).toEqual(cargo.id);
    expect(event.datacontenttype).toBe('application/vnd.awala.cargo');
    expect(event.data).toMatchObject(cargoSerialization);

    expect(getMockLogs()).toContainEqual(
      partialPinoLog('info', 'Processing valid cargo', {
        cargoId: cargo.id,
        grpcClient: CALL.getPeer(),
        grpcMethod: 'deliverCargo',
        privatePeerId: privateGatewayId,
      }),
    );
  });

  test('Processing should continue after ignoring invalid/malformed cargo', async () => {
    // The invalid message is followed by a valid one to check that processing continues
    const invalidDeliveryId = 'invalid';
    CALL.output.push(
      { cargo: Buffer.from('invalid cargo'), id: invalidDeliveryId },
      {
        cargo: cargoSerialization,
        id: DELIVERY_ID,
      },
    );
    await SERVICE.deliverCargo(CALL.convertToGrpcStream());

    expect(CALL.write).toBeCalledTimes(2);
    expect(CALL.write).toBeCalledWith({ id: invalidDeliveryId });
    expect(CALL.write).toBeCalledWith({ id: DELIVERY_ID });

    expect(queueEmitter.events).toHaveLength(1);
    const [event] = queueEmitter.events;
    expect(event.subject).toEqual(cargo.id);
  });

  test('Successful completion should be logged and end the call', async () => {
    CALL.output.push({
      cargo: cargoSerialization,
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
    jest.spyOn(queueEmitter, 'emit').mockRejectedValueOnce(error);
    CALL.output.push({
      cargo: cargoSerialization,
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
    jest.spyOn(queueEmitter, 'emit').mockResolvedValueOnce(undefined);
    jest.spyOn(queueEmitter, 'emit').mockRejectedValueOnce(new Error('Whoops'));
    const undeliveredMessageId = 'undelivered';
    CALL.output.push(
      { cargo: cargoSerialization, id: DELIVERY_ID },
      { cargo: cargoSerialization, id: undeliveredMessageId },
    );

    await catchErrorEvent(CALL, () => SERVICE.deliverCargo(CALL.convertToGrpcStream()));

    expect(CALL.write).toBeCalledTimes(1);
    expect(CALL.write).toBeCalledWith({ id: DELIVERY_ID });
  });

  test('Trusted certificates should be retrieved once in the lifetime of the call', async () => {
    // Even if multiple cargoes are received
    CALL.output.push(
      { cargo: cargoSerialization, id: `${DELIVERY_ID}-1` },
      { cargo: cargoSerialization, id: `${DELIVERY_ID}-2` },
    );
    await SERVICE.deliverCargo(CALL.convertToGrpcStream());

    expect(RETRIEVE_OWN_CERTIFICATES_SPY).toBeCalledTimes(1);
  });
});
