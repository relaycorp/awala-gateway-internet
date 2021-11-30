import * as grpc from '@grpc/grpc-js';
import { CargoDelivery, CargoDeliveryAck, CargoRelayServerMethodSet } from '@relaycorp/cogrpc';
import {
  Cargo,
  CargoCollectionAuthorization,
  CargoMessageSet,
  CargoMessageStream,
  generateRSAKeyPair,
  InvalidMessageError,
  issueEndpointCertificate,
  MockPrivateKeyStore,
  Parcel,
  ParcelCollectionAck,
  RAMFSyntaxError,
  RecipientAddressType,
  SessionEnvelopedData,
  SessionKeyPair,
  UnknownKeyError,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { addDays } from 'date-fns';
import { EventEmitter } from 'events';

import {
  arrayBufferFrom,
  arrayToAsyncIterable,
  CDAChain,
  generateCCA,
  generateCDAChain,
  makeMockLogging,
  mockSpy,
  partialPinoLog,
  partialPinoLogger,
  PdaChain,
  setUpTestDBConnection,
  UUID4_REGEX,
} from '../../_test_utils';
import * as natsStreaming from '../../backingServices/natsStreaming';
import * as vault from '../../backingServices/vault';
import * as ccaFulfillments from '../../ccaFulfilments';
import * as certs from '../../certs';
import { MongoCertificateStore } from '../../keystores/MongoCertificateStore';
import * as parcelCollectionAck from '../../parcelCollection';
import { ParcelStore } from '../../parcelStore';
import { Config, ConfigKey } from '../../utilities/config';
import { configureMockEnvVars, generatePdaChain, getMockInstance } from '../_test_utils';
import { MockGrpcBidiCall } from './_test_utils';
import { makeServiceImplementation, ServiceImplementationOptions } from './service';

//region Fixtures

const PUBLIC_ADDRESS = 'gateway.com';
const PUBLIC_ADDRESS_URL = `https://${PUBLIC_ADDRESS}`;
const OBJECT_STORE_BUCKET = 'parcels-bucket';
const NATS_SERVER_URL = 'nats://example.com';
const NATS_CLUSTER_ID = 'nats-cluster-id';

const TOMORROW = addDays(new Date(), 1);

let pdaChain: PdaChain;
let cdaChain: CDAChain;
let privateGatewayAddress: string;
beforeAll(async () => {
  pdaChain = await generatePdaChain();
  cdaChain = await generateCDAChain(pdaChain);
  privateGatewayAddress = await pdaChain.privateGatewayCert.calculateSubjectPrivateAddress();
});

const getMongooseConnection = setUpTestDBConnection();

configureMockEnvVars({
  OBJECT_STORE_ACCESS_KEY_ID: 'id',
  OBJECT_STORE_BACKEND: 'minio',
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
    getMongooseConnection: jest.fn().mockImplementation(getMongooseConnection),
    natsClusterId: NATS_CLUSTER_ID,
    natsServerUrl: NATS_SERVER_URL,
    parcelStoreBucket: OBJECT_STORE_BUCKET,
    publicAddress: PUBLIC_ADDRESS,
  };
});

//endregion

describe('makeServiceImplementation', () => {
  describe('Mongoose connection', () => {
    test('Connection should be created preemptively before any RPC', async () => {
      expect(SERVICE_IMPLEMENTATION_OPTIONS.getMongooseConnection).not.toBeCalled();

      await makeServiceImplementation(SERVICE_IMPLEMENTATION_OPTIONS);

      expect(SERVICE_IMPLEMENTATION_OPTIONS.getMongooseConnection).toBeCalled();
    });

    test('Errors while establishing connection should be propagated', async () => {
      const error = new Error('Database credentials are wrong');
      getMockInstance(SERVICE_IMPLEMENTATION_OPTIONS.getMongooseConnection).mockRejectedValue(
        error,
      );

      await expect(makeServiceImplementation(SERVICE_IMPLEMENTATION_OPTIONS)).rejects.toEqual(
        error,
      );
    });

    test('Errors after establishing connection should be logged', async (cb) => {
      const mockConnection = new EventEmitter();
      getMockInstance(SERVICE_IMPLEMENTATION_OPTIONS.getMongooseConnection).mockResolvedValue(
        mockConnection,
      );
      await makeServiceImplementation(SERVICE_IMPLEMENTATION_OPTIONS);

      const error = new Error('Database credentials are wrong');

      mockConnection.on('error', (err) => {
        expect(MOCK_LOGS).toContainEqual(
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
    CARGO = new Cargo(PUBLIC_ADDRESS_URL, pdaChain.privateGatewayCert, Buffer.from('payload'));
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
    SERVICE = await makeServiceImplementation(SERVICE_IMPLEMENTATION_OPTIONS);
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
        PUBLIC_ADDRESS_URL,
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

      expect(MOCK_LOGS).toContainEqual(
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

describe('collectCargo', () => {
  const PRIVATE_KEY_STORE = new MockPrivateKeyStore();
  let publicGatewaySessionKeyPair: SessionKeyPair;
  beforeAll(async () => {
    publicGatewaySessionKeyPair = await SessionKeyPair.generate();
  });
  beforeEach(async () => {
    PRIVATE_KEY_STORE.clear();
    await PRIVATE_KEY_STORE.saveIdentityKey(pdaChain.publicGatewayPrivateKey);
    await PRIVATE_KEY_STORE.saveBoundSessionKey(
      publicGatewaySessionKeyPair.privateKey,
      publicGatewaySessionKeyPair.sessionKey.keyId,
      privateGatewayAddress,
    );
  });
  mockSpy(jest.spyOn(vault, 'initVaultKeyStore'), () => PRIVATE_KEY_STORE);

  beforeEach(async () => {
    const connection = getMongooseConnection();

    const certificateStore = new MongoCertificateStore(connection);
    await certificateStore.save(pdaChain.publicGatewayCert);

    const config = new Config(connection);
    await config.set(
      ConfigKey.CURRENT_PRIVATE_ADDRESS,
      await pdaChain.publicGatewayCert.calculateSubjectPrivateAddress(),
    );
  });
  afterEach(async () => {
    const connection = getMongooseConnection();

    Object.values(connection.collections).map((c) => c.deleteMany({}));
  });

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
    () => arrayToAsyncIterable([]),
  );
  const MOCK_GENERATE_PCAS = mockSpy(
    jest.spyOn(parcelCollectionAck, 'generatePCAs'),
    async function* (): CargoMessageStream {
      yield* arrayToAsyncIterable([]);
    },
  );

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

  let ccaSerialized: Buffer;
  let privateGatewaySessionPrivateKey: CryptoKey;
  beforeAll(async () => {
    const generatedCCA = await generateCCA(
      PUBLIC_ADDRESS_URL,
      cdaChain,
      publicGatewaySessionKeyPair.sessionKey,
      pdaChain.privateGatewayPrivateKey,
    );
    ccaSerialized = generatedCCA.ccaSerialized;
    privateGatewaySessionPrivateKey = generatedCCA.sessionPrivateKey;
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

      const invalidCCASerialized = Buffer.from('I am not really a RAMF message');
      CALL.metadata.add('Authorization', `Relaynet-CCA ${invalidCCASerialized.toString('base64')}`);

      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });

    test('UNAUTHENTICATED should be returned if payload is not an EnvelopedData value', async (cb) => {
      CALL.on('error', (error) => {
        expect(MOCK_LOGS).toContainEqual(invalidCCRLog('CMSError'));
        expect(error).toEqual({
          code: grpc.status.UNAUTHENTICATED,
          message: 'Invalid CCA',
        });

        cb();
      });

      const invalidCCASerialized = await generateCCAForPayload(
        PUBLIC_ADDRESS_URL,
        new ArrayBuffer(0),
      );
      CALL.metadata.add('Authorization', `Relaynet-CCA ${invalidCCASerialized.toString('base64')}`);

      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });

    test('UNAUTHENTICATED should be returned if EnvelopedData cannot be decrypted', async (cb) => {
      CALL.on('error', (error) => {
        expect(MOCK_LOGS).toContainEqual(invalidCCRLog(UnknownKeyError.name));
        expect(error).toEqual({
          code: grpc.status.UNAUTHENTICATED,
          message: 'Invalid CCA',
        });

        cb();
      });

      const unknownSessionKey = (await SessionKeyPair.generate()).sessionKey;
      const { envelopedData } = await SessionEnvelopedData.encrypt(
        new ArrayBuffer(0),
        unknownSessionKey, // The public gateway doesn't have this key
      );
      const invalidCCASerialized = await generateCCAForPayload(
        PUBLIC_ADDRESS_URL,
        envelopedData.serialize(),
      );
      CALL.metadata.add('Authorization', `Relaynet-CCA ${invalidCCASerialized.toString('base64')}`);

      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });

    test('UNAUTHENTICATED should be returned if CCR is malformed', async (cb) => {
      CALL.on('error', (error) => {
        expect(MOCK_LOGS).toContainEqual(invalidCCRLog(InvalidMessageError.name));
        expect(error).toEqual({
          code: grpc.status.UNAUTHENTICATED,
          message: 'Invalid CCA',
        });

        cb();
      });

      const { envelopedData } = await SessionEnvelopedData.encrypt(
        arrayBufferFrom('not a valid CCR'),
        publicGatewaySessionKeyPair.sessionKey,
      );
      const invalidCCASerialized = await generateCCAForPayload(
        PUBLIC_ADDRESS_URL,
        envelopedData.serialize(),
      );
      CALL.metadata.add('Authorization', `Relaynet-CCA ${invalidCCASerialized.toString('base64')}`);

      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });

    test('INVALID_ARGUMENT should be returned if CCA recipient is malformed', async (cb) => {
      const cca = new CargoCollectionAuthorization(
        '0deadbeef',
        pdaChain.privateGatewayCert,
        Buffer.from([]),
      );
      CALL.on('error', (error) => {
        expect(MOCK_LOGS).toContainEqual(
          partialPinoLog('info', 'Refusing CCA with malformed recipient', {
            ccaRecipientAddress: cca.recipientAddress,
            grpcClient: CALL.getPeer(),
            grpcMethod: 'collectCargo',
            peerGatewayAddress: privateGatewayAddress,
          }),
        );
        expect(error).toEqual({
          code: grpc.status.INVALID_ARGUMENT,
          message: 'CCA recipient is malformed',
        });

        cb();
      });

      const invalidCCASerialized = Buffer.from(
        await cca.serialize(pdaChain.privateGatewayPrivateKey),
      );
      CALL.metadata.add('Authorization', `Relaynet-CCA ${invalidCCASerialized.toString('base64')}`);

      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });

    test('INVALID_ARGUMENT should be returned if CCA is not bound for current gateway', async (cb) => {
      const cca = new CargoCollectionAuthorization(
        `https://different-${PUBLIC_ADDRESS}`,
        pdaChain.privateGatewayCert,
        Buffer.from([]),
      );
      CALL.on('error', (error) => {
        expect(MOCK_LOGS).toContainEqual(
          partialPinoLog('info', 'Refusing CCA bound for another gateway', {
            ccaRecipientAddress: cca.recipientAddress,
            grpcClient: CALL.getPeer(),
            grpcMethod: 'collectCargo',
            peerGatewayAddress: privateGatewayAddress,
          }),
        );
        expect(error).toEqual({
          code: grpc.status.INVALID_ARGUMENT,
          message: 'CCA recipient is a different gateway',
        });

        cb();
      });

      const invalidCCASerialized = Buffer.from(
        await cca.serialize(pdaChain.privateGatewayPrivateKey),
      );
      CALL.metadata.add('Authorization', `Relaynet-CCA ${invalidCCASerialized.toString('base64')}`);

      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });

    test('PERMISSION_DENIED should be returned if CCA was already fulfilled', async (cb) => {
      CALL.on('error', (error) => {
        expect(MOCK_LOGS).toContainEqual(
          partialPinoLog('info', 'Refusing CCA that was already fulfilled', {
            grpcClient: CALL.getPeer(),
            grpcMethod: 'collectCargo',
            peerGatewayAddress: privateGatewayAddress,
          }),
        );
        expect(error).toEqual({
          code: grpc.status.PERMISSION_DENIED,
          message: 'CCA was already fulfilled',
        });

        cb();
      });

      MOCK_WAS_CCA_FULFILLED.mockResolvedValue(true);
      CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });

    function invalidCCALog(errorMessage: string): ReturnType<typeof partialPinoLog> {
      return partialPinoLog('info', 'Refusing malformed/invalid CCA', {
        grpcClient: CALL.getPeer(),
        grpcMethod: 'collectCargo',
        reason: errorMessage,
      });
    }

    function invalidCCRLog(errorTypeName: string): ReturnType<typeof partialPinoLog> {
      return partialPinoLog('info', 'Failed to extract Cargo Collection Request', {
        err: expect.objectContaining({ type: errorTypeName }),
        grpcClient: CALL.getPeer(),
        grpcMethod: 'collectCargo',
      });
    }
  });

  test('Parcel store should be bound to correct bucket', async () => {
    CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(MOCK_RETRIEVE_ACTIVE_PARCELS.mock.instances[0]).toHaveProperty(
      'bucket',
      OBJECT_STORE_BUCKET,
    );
  });

  test('Parcels retrieved should be limited to sender of CCA', async () => {
    CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(MOCK_RETRIEVE_ACTIVE_PARCELS).toBeCalledWith(
      privateGatewayAddress,
      partialPinoLogger({ peerGatewayAddress: privateGatewayAddress }) as any,
    );
  });

  test('Call should end immediately if there is no cargo for specified gateway', async () => {
    CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(CALL.write).not.toBeCalled();
    expect(CALL.end).toBeCalled();
  });

  test('One cargo should be returned if all messages fit in it', async () => {
    CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

    MOCK_RETRIEVE_ACTIVE_PARCELS.mockReturnValue(
      arrayToAsyncIterable([
        {
          body: DUMMY_PARCEL_SERIALIZED,
          expiryDate: TOMORROW,
          extra: null,
          key: 'prefix/1.parcel',
        },
      ]),
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
    CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

    MOCK_RETRIEVE_ACTIVE_PARCELS.mockReturnValue(
      arrayToAsyncIterable([
        {
          body: DUMMY_PARCEL_SERIALIZED,
          expiryDate: TOMORROW,
          extra: null,
          key: 'prefix/1.parcel',
        },
      ]),
    );

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(CALL.end).toBeCalled();
  });

  test('PCAs should be limited to the sender of the CCA', async () => {
    CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(MOCK_GENERATE_PCAS).toBeCalledTimes(1);
    expect(MOCK_GENERATE_PCAS).toBeCalledWith(
      await pdaChain.privateGatewayCert.calculateSubjectPrivateAddress(),
      getMongooseConnection(),
    );
  });

  test('PCAs should be included in payload', async () => {
    CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

    MOCK_RETRIEVE_ACTIVE_PARCELS.mockReturnValue(
      arrayToAsyncIterable([
        {
          body: DUMMY_PARCEL_SERIALIZED,
          expiryDate: TOMORROW,
          extra: null,
          key: 'prefix/1.parcel',
        },
      ]),
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

  test('Cargo should be signed with the current key', async () => {
    CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));
    MOCK_RETRIEVE_ACTIVE_PARCELS.mockReturnValue(
      arrayToAsyncIterable([
        {
          body: DUMMY_PARCEL_SERIALIZED,
          expiryDate: TOMORROW,
          extra: null,
          key: 'prefix/1.parcel',
        },
      ]),
    );

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(CALL.input).toHaveLength(1);
    const cargo = await Cargo.deserialize(bufferToArray(CALL.input[0].cargo));
    await cargo.validate(RecipientAddressType.PRIVATE, [cdaChain.privateGatewayCert]);
  });

  test('CCA should be logged as fulfilled to make sure it is only used once', async () => {
    CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(MOCK_RECORD_CCA_FULFILLMENT).toBeCalledTimes(1);
    const cca = await CargoCollectionAuthorization.deserialize(bufferToArray(ccaSerialized));
    expect(MOCK_RECORD_CCA_FULFILLMENT).toBeCalledWith(
      expect.objectContaining({ id: cca.id }),
      getMongooseConnection(),
    );
  });

  test('CCA fulfillment should be logged and end the call', async () => {
    CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(MOCK_LOGS).toContainEqual(
      partialPinoLog('info', 'CCA was fulfilled successfully', {
        cargoesCollected: 0,
        grpcClient: CALL.getPeer(),
        grpcMethod: 'collectCargo',
        peerGatewayAddress: privateGatewayAddress,
      }),
    );
    expect(CALL.end).toBeCalledWith();
  });

  test('CCA payload encryption key should be stored', async () => {
    CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));
    MOCK_RETRIEVE_ACTIVE_PARCELS.mockReturnValue(
      arrayToAsyncIterable([
        {
          body: DUMMY_PARCEL_SERIALIZED,
          expiryDate: TOMORROW,
          extra: null,
          key: 'prefix/1.parcel',
        },
      ]),
    );

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(CALL.input).toHaveLength(1);
    const cargo = await Cargo.deserialize(bufferToArray(CALL.input[0].cargo));
    const cargoUnwrap = await cargo.unwrapPayload(privateGatewaySessionPrivateKey);
    expect(cargoUnwrap.payload.messages).toHaveLength(1);
  });

  describe('Errors while generating cargo', () => {
    const err = new Error('Whoops');
    beforeEach(() => {
      MOCK_RETRIEVE_ACTIVE_PARCELS.mockImplementation(async function* (): AsyncIterable<any> {
        throw err;
      });
      CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));
    });

    test('Error should be logged and end the call', async (cb) => {
      CALL.on('error', async () => {
        expect(MOCK_LOGS).toContainEqual(
          partialPinoLog('error', 'Failed to send cargo', {
            err: expect.objectContaining({ message: err.message }),
            grpcClient: CALL.getPeer(),
            grpcMethod: 'collectCargo',
            peerGatewayAddress: privateGatewayAddress,
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

  function serializeAuthzMetadata(ccaSerialization: Buffer): string {
    return `Relaynet-CCA ${ccaSerialization.toString('base64')}`;
  }

  async function generateCCAForPayload(
    recipientAddress: string,
    payload: ArrayBuffer,
  ): Promise<Buffer> {
    const cca = new CargoCollectionAuthorization(
      recipientAddress,
      pdaChain.privateGatewayCert,
      Buffer.from(payload),
    );
    return Buffer.from(await cca.serialize(pdaChain.privateGatewayPrivateKey));
  }

  async function validateCargoDelivery(
    cargoDelivery: CargoDelivery,
    expectedMessagesSerialized: readonly Buffer[],
  ): Promise<void> {
    expect(cargoDelivery).toHaveProperty('id', UUID4_REGEX);

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
    const { payload } = await cargo.unwrapPayload(privateGatewaySessionPrivateKey);
    return payload;
  }
});
