/* tslint:disable:no-let */

import { CargoDelivery, CargoDeliveryAck, CargoRelayServerMethodSet } from '@relaycorp/cogrpc';
import { VaultPrivateKeyStore } from '@relaycorp/keystore-vault';
import {
  Cargo,
  CargoCollectionAuthorization,
  CargoMessageSet,
  CargoMessageStream,
  generateRSAKeyPair,
  InvalidMessageError,
  issueEndpointCertificate,
  Parcel,
  ParcelCollectionAck,
  RAMFSyntaxError,
} from '@relaycorp/relaynet-core';
import * as typegoose from '@typegoose/typegoose';
import bufferToArray from 'buffer-to-arraybuffer';
import { EventEmitter } from 'events';
import * as grpc from 'grpc';
import mongoose from 'mongoose';

import {
  arrayToAsyncIterable,
  makeMockLogging,
  mockSpy,
  partialPinoLog,
  PdaChain,
} from '../../_test_utils';
import * as mongo from '../../backingServices/mongo';
import * as natsStreaming from '../../backingServices/natsStreaming';
import { configureMockEnvVars, generatePdaChain, getMockInstance } from '../_test_utils';
import * as ccaFulfillments from '../ccaFulfilments';
import * as certs from '../certs';
import { MongoPublicKeyStore } from '../MongoPublicKeyStore';
import * as parcelCollectionAck from '../parcelCollection';
import { ParcelStore } from '../parcelStore';
import { MockGrpcBidiCall } from './_test_utils';
import { makeServiceImplementation, ServiceImplementationOptions } from './service';

//region Fixtures

const COGRPC_ADDRESS = 'https://cogrpc.example.com/';
const GATEWAY_KEY_ID_BASE64 = 'MTM1Nzkk';
const OBJECT_STORE_BUCKET = 'parcels-bucket';
const NATS_SERVER_URL = 'nats://example.com';
const NATS_CLUSTER_ID = 'nats-cluster-id';

const TOMORROW = new Date();
TOMORROW.setDate(TOMORROW.getDate() + 1);

let PDA_CHAIN: PdaChain;
let PEER_GATEWAY_ADDRESS: string;
beforeAll(async () => {
  PDA_CHAIN = await generatePdaChain();
  PEER_GATEWAY_ADDRESS = await PDA_CHAIN.privateGatewayCert.calculateSubjectPrivateAddress();
});

const MOCK_MONGOOSE_CONNECTION: mongoose.Connection = new EventEmitter() as any;
const MOCK_CREATE_MONGOOSE_CONNECTION = mockSpy(
  jest.spyOn(mongo, 'createMongooseConnectionFromEnv'),
  jest.fn().mockResolvedValue(MOCK_MONGOOSE_CONNECTION),
);
beforeEach(() => MOCK_MONGOOSE_CONNECTION.removeAllListeners());

configureMockEnvVars({
  OBJECT_STORE_ACCESS_KEY_ID: 'id',
  OBJECT_STORE_ENDPOINT: 'http://localhost.example',
  OBJECT_STORE_SECRET_KEY: 's3cr3t',
  VAULT_KV_PREFIX: 'prefix',
  VAULT_TOKEN: 'token',
  VAULT_URL: 'http://vault.example',
});

let MOCK_LOGS: readonly object[];
let SERVICE_IMPLEMENTATION_OPTIONS: ServiceImplementationOptions;
beforeEach(() => {
  const mockLogging = makeMockLogging();
  MOCK_LOGS = mockLogging.logs;
  SERVICE_IMPLEMENTATION_OPTIONS = {
    baseLogger: mockLogging.logger,
    cogrpcAddress: COGRPC_ADDRESS,
    gatewayKeyIdBase64: GATEWAY_KEY_ID_BASE64,
    natsClusterId: NATS_CLUSTER_ID,
    natsServerUrl: NATS_SERVER_URL,
    parcelStoreBucket: OBJECT_STORE_BUCKET,
  };
});

//endregion

describe('makeServiceImplementation', () => {
  describe('Mongoose connection', () => {
    test('Connection should be created preemptively before any RPC', async () => {
      expect(MOCK_CREATE_MONGOOSE_CONNECTION).not.toBeCalled();

      await makeServiceImplementation(SERVICE_IMPLEMENTATION_OPTIONS);

      expect(MOCK_CREATE_MONGOOSE_CONNECTION).toBeCalledTimes(1);
    });

    test('Errors while establishing connection should be propagated', async () => {
      const error = new Error('Database credentials are wrong');
      MOCK_CREATE_MONGOOSE_CONNECTION.mockRejectedValue(error);

      await expect(makeServiceImplementation(SERVICE_IMPLEMENTATION_OPTIONS)).rejects.toEqual(
        error,
      );
    });

    test('Errors after establishing connection should be logged', async (cb) => {
      await makeServiceImplementation(SERVICE_IMPLEMENTATION_OPTIONS);

      const error = new Error('Database credentials are wrong');

      MOCK_MONGOOSE_CONNECTION.on('error', (err) => {
        expect(MOCK_LOGS).toContainEqual(
          partialPinoLog('error', 'Mongoose connection error', {
            err: expect.objectContaining({ message: err.message }),
          }),
        );
        cb();
      });
      MOCK_MONGOOSE_CONNECTION.emit('error', error);
    });
  });
});

describe('deliverCargo', () => {
  const DELIVERY_ID = 'the-id';

  let CARGO: Cargo;
  let CARGO_SERIALIZATION: Buffer;
  beforeAll(async () => {
    CARGO = new Cargo(COGRPC_ADDRESS, PDA_CHAIN.privateGatewayCert, Buffer.from('payload'));
    CARGO_SERIALIZATION = Buffer.from(await CARGO.serialize(PDA_CHAIN.privateGatewayPrivateKey));
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
    NATS_CLIENT = ({
      disconnect: jest.fn(),
      makePublisher: jest.fn().mockReturnValue(mockNatsPublisher),
    } as unknown) as natsStreaming.NatsStreamingClient;
  });
  const mockNatsClientClass = mockSpy(
    jest.spyOn(natsStreaming, 'NatsStreamingClient'),
    () => NATS_CLIENT,
  );

  let SERVICE: CargoRelayServerMethodSet;
  beforeEach(async () => {
    SERVICE = await makeServiceImplementation(SERVICE_IMPLEMENTATION_OPTIONS);
  });

  let CALL: MockGrpcBidiCall<CargoDeliveryAck, CargoDelivery>;
  beforeEach(() => {
    CALL = new MockGrpcBidiCall();
  });

  const RETRIEVE_OWN_CERTIFICATES_SPY = mockSpy(
    jest.spyOn(certs, 'retrieveOwnCertificates'),
    () => [PDA_CHAIN.publicGatewayCert],
  );

  test('NATS Streaming publisher should be initialized upfront', async () => {
    expect(mockNatsClientClass).not.toBeCalled();

    await SERVICE.deliverCargo(CALL.convertToGrpcStream());

    expect(mockNatsClientClass).toBeCalledTimes(1);
    expect(mockNatsClientClass).toBeCalledWith(
      NATS_SERVER_URL,
      NATS_CLUSTER_ID,
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

      expect(MOCK_LOGS).toContainEqual(
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
        COGRPC_ADDRESS,
        PDA_CHAIN.peerEndpointCert,
        Buffer.from('payload'),
      );
      const invalidCargoSerialized = await invalidCargo.serialize(PDA_CHAIN.peerEndpointPrivateKey);
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

      expect(MOCK_LOGS).toContainEqual(
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

      expect(MOCK_LOGS).toContainEqual(
        partialPinoLog('info', 'Processing valid cargo', {
          cargoId: CARGO.id,
          grpcClient: CALL.getPeer(),
          grpcMethod: 'deliverCargo',
          peerGatewayAddress: PEER_GATEWAY_ADDRESS,
        }),
      );
    });

    test('Successful completion should be logged', async () => {
      CALL.output.push({
        cargo: CARGO_SERIALIZATION,
        id: DELIVERY_ID,
      });

      await SERVICE.deliverCargo(CALL.convertToGrpcStream());

      expect(MOCK_LOGS).toContainEqual(
        partialPinoLog('info', 'Cargo delivery completed successfully', {
          cargoesDelivered: 1,
          grpcClient: CALL.getPeer(),
          grpcMethod: 'deliverCargo',
        }),
      );
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
        expect(MOCK_LOGS).toContainEqual(
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

    test('NATS Streaming connection should be closed upon completion', async () => {
      CALL.output.push({
        cargo: CARGO_SERIALIZATION,
        id: DELIVERY_ID,
      });

      await SERVICE.deliverCargo(CALL.convertToGrpcStream());

      expect(NATS_CLIENT.disconnect).toBeCalledTimes(1);
    });

    test('NATS Streaming connection should be closed upon error', async (cb) => {
      async function* throwError(
        messages: AsyncIterable<natsStreaming.PublisherMessage>,
      ): AsyncIterable<string> {
        for await (const message of messages) {
          yield message.id;
        }
        throw new Error('Denied');
      }
      getMockInstance(NATS_CLIENT.makePublisher).mockReturnValue(throwError);
      CALL.output.push({
        cargo: CARGO_SERIALIZATION,
        id: DELIVERY_ID,
      });

      CALL.on('error', () => {
        setImmediate(() => {
          expect(NATS_CLIENT.disconnect).toBeCalledTimes(1);
          cb();
        });
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

describe('collectCargo', () => {
  let SERVICE: CargoRelayServerMethodSet;
  beforeEach(async () => {
    SERVICE = await makeServiceImplementation(SERVICE_IMPLEMENTATION_OPTIONS);
  });

  let CALL: MockGrpcBidiCall<CargoDelivery, CargoDeliveryAck>;
  beforeEach(() => {
    CALL = new MockGrpcBidiCall();
  });

  const MOCK_RETRIEVE_ACTIVE_PARCELS = mockSpy(
    jest.spyOn(ParcelStore.prototype, 'retrieveActiveParcelsForGateway'),
    async () => arrayToAsyncIterable([]),
  );
  const MOCK_GENERATE_PCAS = mockSpy(
    jest.spyOn(parcelCollectionAck, 'generatePCAs'),
    async function* (): CargoMessageStream {
      yield* arrayToAsyncIterable([]);
    },
  );

  const MOCK_FETCH_NODE_KEY = mockSpy(
    jest.spyOn(VaultPrivateKeyStore.prototype, 'fetchNodeKey'),
    async () => ({
      certificate: PDA_CHAIN.publicGatewayCert,
      privateKey: PDA_CHAIN.publicGatewayPrivateKey,
    }),
  );

  mockSpy(jest.spyOn(typegoose, 'getModelForClass'));
  mockSpy(jest.spyOn(MongoPublicKeyStore.prototype, 'fetchLastSessionKey'), async () => {
    throw new Error('Do not use session keys');
  });

  const MOCK_WAS_CCA_FULFILLED = mockSpy(
    jest.spyOn(ccaFulfillments, 'wasCCAFulfilled'),
    async () => false,
  );
  const MOCK_RECORD_CCA_FULFILLMENT = mockSpy(
    jest.spyOn(ccaFulfillments, 'recordCCAFulfillment'),
    async () => null,
  );

  let DUMMY_PARCEL: Parcel;
  let DUMMY_PARCEL_SERIALIZED: Buffer;
  beforeAll(async () => {
    const keyPair = await generateRSAKeyPair();
    const certificate = await issueEndpointCertificate({
      issuerPrivateKey: keyPair.privateKey,
      subjectPublicKey: keyPair.publicKey,
      validityEndDate: TOMORROW,
    });
    DUMMY_PARCEL = new Parcel(
      await certificate.calculateSubjectPrivateAddress(),
      certificate,
      Buffer.from('Pretend this is a CMS EnvelopedData value'),
    );
    DUMMY_PARCEL_SERIALIZED = Buffer.from(await DUMMY_PARCEL.serialize(keyPair.privateKey));
  });

  let CCA: CargoCollectionAuthorization;
  let AUTHORIZATION_METADATA: grpc.MetadataValue;
  beforeAll(async () => {
    CCA = new CargoCollectionAuthorization(
      COGRPC_ADDRESS,
      PDA_CHAIN.privateGatewayCert,
      Buffer.from([]),
    );
    const ccaSerialized = Buffer.from(await CCA.serialize(PDA_CHAIN.privateGatewayPrivateKey));
    AUTHORIZATION_METADATA = `Relaynet-CCA ${ccaSerialized.toString('base64')}`;
  });

  describe('CCA validation', () => {
    test('UNAUTHENTICATED should be returned if Authorization is missing', async (cb) => {
      CALL.on('error', (error) => {
        const errorMessage = 'Authorization metadata should be specified exactly once';
        expect(MOCK_LOGS).toContainEqual(invalidCCALog(errorMessage));
        expect(error).toEqual({
          code: grpc.status.UNAUTHENTICATED,
          message: errorMessage,
        });

        cb();
      });

      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });

    test('UNAUTHENTICATED should be returned if Authorization is duplicated', async (cb) => {
      CALL.on('error', (error) => {
        const errorMessage = 'Authorization metadata should be specified exactly once';
        expect(MOCK_LOGS).toContainEqual(invalidCCALog(errorMessage));
        expect(error).toEqual({
          code: grpc.status.UNAUTHENTICATED,
          message: errorMessage,
        });

        cb();
      });

      CALL.metadata.add('Authorization', 'Bearer s3cr3t');
      CALL.metadata.add('Authorization', 'Bearer s3cr3t');
      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });

    test('UNAUTHENTICATED should be returned if Authorization type is invalid', async (cb) => {
      CALL.on('error', (error) => {
        const errorMessage = 'Authorization type should be Relaynet-CCA';
        expect(MOCK_LOGS).toContainEqual(invalidCCALog(errorMessage));
        expect(error).toEqual({
          code: grpc.status.UNAUTHENTICATED,
          message: errorMessage,
        });

        cb();
      });

      CALL.metadata.add('Authorization', 'Bearer s3cr3t');

      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });

    test('UNAUTHENTICATED should be returned if Authorization value is missing', async (cb) => {
      CALL.on('error', (error) => {
        const errorMessage = 'Authorization value should be set to the CCA';
        expect(MOCK_LOGS).toContainEqual(invalidCCALog(errorMessage));
        expect(error).toEqual({
          code: grpc.status.UNAUTHENTICATED,
          message: errorMessage,
        });

        cb();
      });

      CALL.metadata.add('Authorization', 'Relaynet-CCA');

      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });

    test('UNAUTHENTICATED should be returned if CCA is malformed', async (cb) => {
      CALL.on('error', (error) => {
        const errorMessage = 'CCA is malformed';
        expect(MOCK_LOGS).toContainEqual(invalidCCALog(errorMessage));
        expect(error).toEqual({
          code: grpc.status.UNAUTHENTICATED,
          message: errorMessage,
        });

        cb();
      });

      const ccaSerialized = Buffer.from('I am not really a RAMF message');
      CALL.metadata.add('Authorization', `Relaynet-CCA ${ccaSerialized.toString('base64')}`);

      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });

    test('INVALID_ARGUMENT should be returned if CCA is not bound for current gateway', async (cb) => {
      const cca = new CargoCollectionAuthorization(
        `${COGRPC_ADDRESS}/path`,
        PDA_CHAIN.privateGatewayCert,
        Buffer.from([]),
      );
      CALL.on('error', (error) => {
        expect(MOCK_LOGS).toContainEqual(
          partialPinoLog('info', 'Refusing CCA bound for another gateway', {
            ccaRecipientAddress: cca.recipientAddress,
            grpcClient: CALL.getPeer(),
            grpcMethod: 'collectCargo',
            peerGatewayAddress: PEER_GATEWAY_ADDRESS,
          }),
        );
        expect(error).toEqual({
          code: grpc.status.INVALID_ARGUMENT,
          message: 'CCA recipient is a different gateway',
        });

        cb();
      });

      const ccaSerialized = Buffer.from(await cca.serialize(PDA_CHAIN.privateGatewayPrivateKey));
      CALL.metadata.add('Authorization', `Relaynet-CCA ${ccaSerialized.toString('base64')}`);

      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });

    test('PERMISSION_DENIED should be returned if CCA was already fulfilled', async (cb) => {
      CALL.on('error', (error) => {
        expect(MOCK_LOGS).toContainEqual(
          partialPinoLog('info', 'Refusing CCA that was already fulfilled', {
            grpcClient: CALL.getPeer(),
            grpcMethod: 'collectCargo',
            peerGatewayAddress: PEER_GATEWAY_ADDRESS,
          }),
        );
        expect(error).toEqual({
          code: grpc.status.PERMISSION_DENIED,
          message: 'CCA was already fulfilled',
        });

        cb();
      });

      MOCK_WAS_CCA_FULFILLED.mockResolvedValue(true);
      CALL.metadata.add('Authorization', AUTHORIZATION_METADATA);

      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });

    function invalidCCALog(errorMessage: string): ReturnType<typeof partialPinoLog> {
      return partialPinoLog('info', 'Refusing malformed/invalid CCA', {
        grpcClient: CALL.getPeer(),
        grpcMethod: 'collectCargo',
        reason: errorMessage,
      });
    }
  });

  test('Parcel store should be bound to correct bucket', async () => {
    CALL.metadata.add('Authorization', AUTHORIZATION_METADATA);

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(MOCK_RETRIEVE_ACTIVE_PARCELS.mock.instances[0]).toHaveProperty(
      'bucket',
      OBJECT_STORE_BUCKET,
    );
  });

  test('Parcels retrieved should be limited to sender of CCA', async () => {
    CALL.metadata.add('Authorization', AUTHORIZATION_METADATA);

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(MOCK_RETRIEVE_ACTIVE_PARCELS).toBeCalledWith(
      await PDA_CHAIN.privateGatewayCert.calculateSubjectPrivateAddress(),
    );
  });

  test('Call should end immediately if there is no cargo for specified gateway', async () => {
    CALL.metadata.add('Authorization', AUTHORIZATION_METADATA);

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(CALL.write).not.toBeCalled();
    expect(CALL.end).toBeCalled();
  });

  test('One cargo should be returned if all messages fit in it', async () => {
    CALL.metadata.add('Authorization', AUTHORIZATION_METADATA);

    MOCK_RETRIEVE_ACTIVE_PARCELS.mockImplementation(() =>
      arrayToAsyncIterable([{ expiryDate: TOMORROW, message: DUMMY_PARCEL_SERIALIZED }]),
    );

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(CALL.input).toHaveLength(1);
    await validateCargoDelivery(CALL.input[0], [DUMMY_PARCEL_SERIALIZED]);
    expect(MOCK_LOGS).toContainEqual(
      partialPinoLog('info', 'CCA was fulfilled successfully', {
        cargoesCollected: 1,
      }),
    );
  });

  test('Call should end after cargo has been delivered', async () => {
    CALL.metadata.add('Authorization', AUTHORIZATION_METADATA);

    MOCK_RETRIEVE_ACTIVE_PARCELS.mockImplementation(() =>
      arrayToAsyncIterable([{ expiryDate: TOMORROW, message: DUMMY_PARCEL_SERIALIZED }]),
    );

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(CALL.end).toBeCalled();
  });

  test('PCAs should be limited to the sender of the CCA', async () => {
    CALL.metadata.add('Authorization', AUTHORIZATION_METADATA);

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(MOCK_GENERATE_PCAS).toBeCalledTimes(1);
    expect(MOCK_GENERATE_PCAS).toBeCalledWith(
      await PDA_CHAIN.privateGatewayCert.calculateSubjectPrivateAddress(),
      MOCK_MONGOOSE_CONNECTION,
    );
  });

  test('PCAs should be included in payload', async () => {
    CALL.metadata.add('Authorization', AUTHORIZATION_METADATA);

    MOCK_RETRIEVE_ACTIVE_PARCELS.mockImplementation(() =>
      arrayToAsyncIterable([{ expiryDate: TOMORROW, message: DUMMY_PARCEL_SERIALIZED }]),
    );
    const pca = new ParcelCollectionAck('0beef', 'https://endpoint.example/', 'the-id');
    const pcaSerialized = Buffer.from(pca.serialize());
    MOCK_GENERATE_PCAS.mockReturnValue(
      arrayToAsyncIterable([{ expiryDate: new Date(), message: pcaSerialized }]),
    );

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(CALL.input).toHaveLength(1);
    await validateCargoDelivery(CALL.input[0], [pcaSerialized, DUMMY_PARCEL_SERIALIZED]);
  });

  test('Cargoes should be signed with current key', async () => {
    CALL.metadata.add('Authorization', AUTHORIZATION_METADATA);

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    const gatewayKeyId = Buffer.from(GATEWAY_KEY_ID_BASE64, 'base64');
    expect(MOCK_FETCH_NODE_KEY).toBeCalledWith(gatewayKeyId);
  });

  test('CCA should be logged as fulfilled to make sure it is only used once', async () => {
    CALL.metadata.add('Authorization', AUTHORIZATION_METADATA);

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(MOCK_RECORD_CCA_FULFILLMENT).toBeCalledTimes(1);
    expect(MOCK_RECORD_CCA_FULFILLMENT).toBeCalledWith(
      expect.objectContaining({ id: CCA.id }),
      MOCK_MONGOOSE_CONNECTION,
    );
  });

  test('CCA fulfillment should be logged', async () => {
    CALL.metadata.add('Authorization', AUTHORIZATION_METADATA);

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(MOCK_LOGS).toContainEqual(
      partialPinoLog('info', 'CCA was fulfilled successfully', {
        cargoesCollected: 0,
        grpcClient: CALL.getPeer(),
        grpcMethod: 'collectCargo',
        peerGatewayAddress: PEER_GATEWAY_ADDRESS,
      }),
    );
  });

  test('Errors while generating cargo should be logged and end the call', async (cb) => {
    const err = new Error('Whoops');
    MOCK_FETCH_NODE_KEY.mockRejectedValue(err);
    CALL.metadata.add('Authorization', AUTHORIZATION_METADATA);

    CALL.on('error', async (callError) => {
      expect(MOCK_LOGS).toContainEqual(
        partialPinoLog('error', 'Failed to send cargo', {
          err: expect.objectContaining({ message: err.message }),
          grpcClient: CALL.getPeer(),
          grpcMethod: 'collectCargo',
          peerGatewayAddress: PEER_GATEWAY_ADDRESS,
        }),
      );

      expect(callError).toEqual({
        code: grpc.status.UNAVAILABLE,
        message: 'Internal server error; please try again later',
      });

      expect(MOCK_RECORD_CCA_FULFILLMENT).not.toBeCalled();

      cb();
    });

    await SERVICE.collectCargo(CALL.convertToGrpcStream());
  });

  describe('Errors while generating cargo', () => {
    const err = new Error('Whoops');
    beforeEach(() => {
      MOCK_FETCH_NODE_KEY.mockRejectedValue(err);
      CALL.metadata.add('Authorization', AUTHORIZATION_METADATA);
    });

    test('Error should be logged and end the call', async (cb) => {
      CALL.on('error', async () => {
        expect(MOCK_LOGS).toContainEqual(
          partialPinoLog('error', 'Failed to send cargo', {
            err: expect.objectContaining({ message: err.message }),
            grpcClient: CALL.getPeer(),
            grpcMethod: 'collectCargo',
            peerGatewayAddress: PEER_GATEWAY_ADDRESS,
          }),
        );
        cb();
      });

      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });

    test('Call should end with an error for the client', async (cb) => {
      CALL.on('error', (callError) => {
        expect(callError).toEqual({
          code: grpc.status.UNAVAILABLE,
          message: 'Internal server error; please try again later',
        });

        cb();
      });

      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });

    test('CCA should not be marked as fulfilled', async (cb) => {
      CALL.on('error', () => {
        expect(MOCK_RECORD_CCA_FULFILLMENT).not.toBeCalled();
        cb();
      });

      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });
  });

  async function validateCargoDelivery(
    cargoDelivery: CargoDelivery,
    expectedMessagesSerialized: readonly Buffer[],
  ): Promise<void> {
    expect(cargoDelivery).toHaveProperty('id', expect.stringMatching(/^[0-9a-f-]+$/));

    expect(cargoDelivery).toHaveProperty('cargo');
    const cargoMessageSet = await unwrapCargoMessages(cargoDelivery.cargo);
    const cargoMessages = Array.from(cargoMessageSet.messages).map((m) => Buffer.from(m));
    expect(cargoMessages).toHaveLength(expectedMessagesSerialized.length);
    for (const expectedMessageSerialized of expectedMessagesSerialized) {
      const matchingMessages = cargoMessages.filter((m) => m.equals(expectedMessageSerialized));
      expect(matchingMessages).toHaveLength(1);
    }
  }

  async function unwrapCargoMessages(cargoSerialized: Buffer): Promise<CargoMessageSet> {
    const cargo = await Cargo.deserialize(bufferToArray(cargoSerialized));
    const { payload } = await cargo.unwrapPayload(PDA_CHAIN.privateGatewayPrivateKey);
    return payload;
  }
});
