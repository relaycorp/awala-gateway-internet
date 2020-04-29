/* tslint:disable:no-let */

import { VaultPrivateKeyStore } from '@relaycorp/keystore-vault';
import {
  CargoDelivery,
  CargoDeliveryAck,
  CargoRelayServerMethodSet,
} from '@relaycorp/relaynet-cogrpc';
import {
  Cargo,
  CargoCollectionAuthorization,
  CargoMessageSet,
  Certificate,
  generateRSAKeyPair,
  issueEndpointCertificate,
  issueGatewayCertificate,
  Parcel,
} from '@relaycorp/relaynet-core';
import * as typegoose from '@typegoose/typegoose';
import bufferToArray from 'buffer-to-arraybuffer';
import * as grpc from 'grpc';
import mongoose from 'mongoose';

import { arrayToAsyncIterable, mockPino, mockSpy } from '../../_test_utils';
import * as natsStreaming from '../../backingServices/natsStreaming';
import {
  configureMockEnvVars,
  expectBuffersToEqual,
  getMockContext,
  makeEmptyCertificate,
} from '../_test_utils';
import * as certs from '../certs';
import { MongoPublicKeyStore } from '../MongoPublicKeyStore';
import { ParcelStore } from '../parcelStore';
import { MockGrpcBidiCall } from './_test_utils';

const MOCK_PINO = mockPino();
import { makeServiceImplementation } from './service';

//region Fixtures

const COGRPC_ADDRESS = 'https://cogrpc.example.com/';
const GATEWAY_KEY_ID_BASE64 = 'MTM1Nzkk';
const PARCEL_STORE_BUCKET = 'parcels-bucket';
const MONGO_URI = 'mongo://example.com';
const NATS_SERVER_URL = 'nats://example.com';
const NATS_CLUSTER_ID = 'nats-cluster-id';

const TOMORROW = new Date();
TOMORROW.setDate(TOMORROW.getDate() + 1);

let OWN_PRIVATE_KEY: CryptoKey;
let OWN_CERTIFICATE: Certificate;
beforeAll(async () => {
  const keyPair = await generateRSAKeyPair();
  OWN_PRIVATE_KEY = keyPair.privateKey;
  OWN_CERTIFICATE = await issueGatewayCertificate({
    issuerPrivateKey: keyPair.privateKey,
    subjectPublicKey: keyPair.publicKey,
    validityEndDate: TOMORROW,
  });
});

const MOCK_MONGOOSE_CONNECTION: mongoose.Connection = { close: mockSpy(jest.fn()) } as any;
const MOCK_MONGOOSE_CREATE_CONNECTION = mockSpy(
  jest.spyOn(mongoose, 'createConnection'),
  () => MOCK_MONGOOSE_CONNECTION,
);

configureMockEnvVars({
  OBJECT_STORE_ACCESS_KEY_ID: 'id',
  OBJECT_STORE_ENDPOINT: 'http://localhost.example',
  OBJECT_STORE_SECRET_KEY: 's3cr3t',
  VAULT_KV_PREFIX: 'prefix',
  VAULT_TOKEN: 'token',
  VAULT_URL: 'http://vault.example',
});

let SERVICE: CargoRelayServerMethodSet;
beforeAll(() => {
  SERVICE = makeServiceImplementation({
    cogrpcAddress: COGRPC_ADDRESS,
    gatewayKeyIdBase64: GATEWAY_KEY_ID_BASE64,
    mongoUri: MONGO_URI,
    natsClusterId: NATS_CLUSTER_ID,
    natsServerUrl: NATS_SERVER_URL,
    parcelStoreBucket: PARCEL_STORE_BUCKET,
  });
});

//endregion

describe('deliverCargo', () => {
  const DELIVERY_ID = 'the-id';
  const CARGO_SERIALIZATION = Buffer.from('Pretend this is a valid cargo');

  const CARGO = new Cargo('0123', makeEmptyCertificate(), Buffer.from('payload'));

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

  let CALL: MockGrpcBidiCall<CargoDeliveryAck, CargoDelivery>;
  beforeEach(() => {
    CALL = new MockGrpcBidiCall();
  });

  const RETRIEVE_OWN_CERTIFICATES_SPY = mockSpy(
    jest.spyOn(certs, 'retrieveOwnCertificates'),
    () => [OWN_CERTIFICATE],
  );

  test('Mongoose connection should be initialized and closed upfront', async () => {
    expect(MOCK_MONGOOSE_CREATE_CONNECTION).not.toBeCalled();

    await SERVICE.deliverCargo(CALL.convertToGrpcStream());

    expect(MOCK_MONGOOSE_CREATE_CONNECTION).toBeCalledTimes(1);
    expect(MOCK_MONGOOSE_CREATE_CONNECTION).toBeCalledWith(MONGO_URI);
    expect(MOCK_MONGOOSE_CONNECTION.close).toBeCalledTimes(1);
  });

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
    const cargoDeserializeSpy = mockSpy(jest.spyOn(Cargo, 'deserialize'), () => CARGO);
    const cargoValidateSpy = mockSpy(jest.spyOn(CARGO, 'validate'));

    test('Malformed message should be ACKd but discarded', async () => {
      // The invalid message is followed by a valid one to check that processing continues
      cargoDeserializeSpy.mockReset();
      cargoDeserializeSpy.mockRejectedValueOnce(new Error('Denied'));
      cargoDeserializeSpy.mockResolvedValueOnce(CARGO);

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
    });

    test('Well-formed yet invalid message should be ACKd but discarded', async () => {
      // The invalid message is followed by a valid one to check that processing continues
      cargoValidateSpy.mockReset();
      cargoValidateSpy.mockRejectedValueOnce(new Error('Denied'));
      cargoValidateSpy.mockResolvedValueOnce(undefined);
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
      ((NATS_CLIENT.makePublisher as unknown) as jest.MockInstance<any, any>).mockReturnValue(
        publishFirstMessageThenFail,
      );
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

      await expect(SERVICE.deliverCargo(CALL.convertToGrpcStream())).rejects.toEqual(error);

      expect(CALL.write).toBeCalledTimes(1);
      expect(CALL.write).toBeCalledWith({ id: DELIVERY_ID });

      // TODO: Log error message
    });

    test('NATS Streaming connection should be closed upon completion', async () => {
      CALL.output.push({
        cargo: CARGO_SERIALIZATION,
        id: DELIVERY_ID,
      });

      await SERVICE.deliverCargo(CALL.convertToGrpcStream());

      expect(NATS_CLIENT.disconnect).toBeCalledTimes(1);
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
      ((NATS_CLIENT.makePublisher as unknown) as jest.MockInstance<any, any>).mockReturnValue(
        throwError,
      );
      CALL.output.push({
        cargo: CARGO_SERIALIZATION,
        id: DELIVERY_ID,
      });

      await expect(SERVICE.deliverCargo(CALL.convertToGrpcStream())).toReject();

      expect(NATS_CLIENT.disconnect).toBeCalledTimes(1);
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

  test('Call should end when client attempts to end connection', async () => {
    await SERVICE.deliverCargo(CALL.convertToGrpcStream());
    expect(CALL.on).toBeCalledWith('end', expect.any(Function));
    const endCallback = getMockContext(CALL.on).calls[0][1];

    expect(CALL.end).toBeCalledTimes(1);
    endCallback();
    expect(CALL.end).toBeCalledTimes(2);
  });
});

describe('collectCargo', () => {
  let CALL: MockGrpcBidiCall<CargoDelivery, CargoDeliveryAck>;
  beforeEach(() => {
    CALL = new MockGrpcBidiCall();
  });

  let CCA_SENDER_PRIVATE_KEY: CryptoKey;
  let CCA_SENDER_CERT: Certificate;
  beforeAll(async () => {
    const keyPair = await generateRSAKeyPair();
    CCA_SENDER_PRIVATE_KEY = keyPair.privateKey;
    CCA_SENDER_CERT = await issueGatewayCertificate({
      issuerPrivateKey: keyPair.privateKey,
      subjectPublicKey: keyPair.publicKey,
      validityEndDate: TOMORROW,
    });
  });

  const MOCK_RETRIEVE_ACTIVE_PARCELS = mockSpy(
    jest.spyOn(ParcelStore.prototype, 'retrieveActiveParcelsForGateway'),
    async () => arrayToAsyncIterable([]),
  );

  const MOCK_FETCH_NODE_KEY = mockSpy(
    jest.spyOn(VaultPrivateKeyStore.prototype, 'fetchNodeKey'),
    async () => ({
      certificate: OWN_CERTIFICATE,
      privateKey: OWN_PRIVATE_KEY,
    }),
  );

  mockSpy(jest.spyOn(typegoose, 'getModelForClass'));
  mockSpy(jest.spyOn(MongoPublicKeyStore.prototype, 'fetchLastSessionKey'), async () => {
    throw new Error('Do not use session keys');
  });

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

  let AUTHORIZATION_METADATA: grpc.MetadataValue;
  beforeAll(async () => {
    const cca = new CargoCollectionAuthorization(COGRPC_ADDRESS, CCA_SENDER_CERT, Buffer.from([]));
    const ccaSerialized = Buffer.from(await cca.serialize(CCA_SENDER_PRIVATE_KEY));
    AUTHORIZATION_METADATA = `Relaynet-CCA ${ccaSerialized.toString('base64')}`;
  });

  describe('CCA validation', () => {
    test('UNAUTHENTICATED should be returned if Authorization is missing', async cb => {
      CALL.on('error', error => {
        expect(error).toEqual({
          code: grpc.status.UNAUTHENTICATED,
          message: 'Authorization metadata should be specified exactly once',
        });

        cb();
      });

      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });

    test('UNAUTHENTICATED should be returned if Authorization is duplicated', async cb => {
      CALL.on('error', error => {
        expect(error).toEqual({
          code: grpc.status.UNAUTHENTICATED,
          message: 'Authorization metadata should be specified exactly once',
        });

        cb();
      });

      CALL.metadata.add('Authorization', 'Bearer s3cr3t');
      CALL.metadata.add('Authorization', 'Bearer s3cr3t');
      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });

    test('UNAUTHENTICATED should be returned if Authorization type is invalid', async cb => {
      CALL.on('error', error => {
        expect(error).toEqual({
          code: grpc.status.UNAUTHENTICATED,
          message: 'Authorization type should be Relaynet-CCA',
        });

        cb();
      });

      CALL.metadata.add('Authorization', 'Bearer s3cr3t');

      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });

    test('UNAUTHENTICATED should be returned if Authorization value is missing', async cb => {
      CALL.on('error', error => {
        expect(error).toEqual({
          code: grpc.status.UNAUTHENTICATED,
          message: 'Authorization value should be set to the CCA',
        });

        cb();
      });

      CALL.metadata.add('Authorization', 'Relaynet-CCA');

      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });

    test('UNAUTHENTICATED should be returned if CCA is malformed', async cb => {
      CALL.on('error', error => {
        expect(error).toEqual({
          code: grpc.status.UNAUTHENTICATED,
          message: 'CCA is malformed',
        });

        cb();
      });

      const ccaSerialized = Buffer.from('I am not really a RAMF message');
      CALL.metadata.add('Authorization', `Relaynet-CCA ${ccaSerialized.toString('base64')}`);

      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });

    test('UNAUTHENTICATED should be returned if CCA is not bound for current gateway', async cb => {
      CALL.on('error', error => {
        expect(error).toEqual({
          code: grpc.status.UNAUTHENTICATED,
          message: 'CCA recipient is a different gateway',
        });

        cb();
      });

      const cca = new CargoCollectionAuthorization(
        `${COGRPC_ADDRESS}/path`,
        CCA_SENDER_CERT,
        Buffer.from([]),
      );
      const ccaSerialized = Buffer.from(await cca.serialize(CCA_SENDER_PRIVATE_KEY));
      CALL.metadata.add('Authorization', `Relaynet-CCA ${ccaSerialized.toString('base64')}`);

      await SERVICE.collectCargo(CALL.convertToGrpcStream());
    });
  });

  test('Mongoose connection should bound to current DB URI', async () => {
    CALL.metadata.add('Authorization', AUTHORIZATION_METADATA);
    expect(MOCK_MONGOOSE_CREATE_CONNECTION).not.toBeCalled();

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(MOCK_MONGOOSE_CREATE_CONNECTION).toBeCalledTimes(1);
    expect(MOCK_MONGOOSE_CREATE_CONNECTION).toBeCalledWith(MONGO_URI);
  });

  test('Parcel store should be bound to correct bucket', async () => {
    CALL.metadata.add('Authorization', AUTHORIZATION_METADATA);

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(MOCK_RETRIEVE_ACTIVE_PARCELS.mock.instances[0]).toHaveProperty(
      'bucket',
      PARCEL_STORE_BUCKET,
    );
  });

  test('Parcels retrieved should be limited to sender of CCA', async () => {
    CALL.metadata.add('Authorization', AUTHORIZATION_METADATA);

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(MOCK_RETRIEVE_ACTIVE_PARCELS).toBeCalledWith(
      await CCA_SENDER_CERT.calculateSubjectPrivateAddress(),
    );
  });

  test.todo('No cargo should be returned if CCA was already used');

  test('Call should end immediately if there is no cargo for specified gateway', async () => {
    CALL.metadata.add('Authorization', AUTHORIZATION_METADATA);

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(CALL.write).not.toBeCalled();
  });

  test('One cargo should be returned if all messages fit in it', async () => {
    CALL.metadata.add('Authorization', AUTHORIZATION_METADATA);

    MOCK_RETRIEVE_ACTIVE_PARCELS.mockImplementation(() =>
      arrayToAsyncIterable([{ expiryDate: TOMORROW, message: DUMMY_PARCEL_SERIALIZED }]),
    );

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(CALL.input).toHaveLength(1);
    await validateCargoDelivery(CALL.input[0]);
  });

  test.todo('PCAs should be included in payload');

  test('Cargoes should be signed with current key', async () => {
    CALL.metadata.add('Authorization', AUTHORIZATION_METADATA);

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    const gatewayKeyId = Buffer.from(GATEWAY_KEY_ID_BASE64, 'base64');
    expect(MOCK_FETCH_NODE_KEY).toBeCalledWith(gatewayKeyId);
  });

  test.todo('CCA should be logged as fulfilled to make sure it is only used once');

  test('Mongoose connection should be closed at the end of the call', async () => {
    CALL.metadata.add('Authorization', AUTHORIZATION_METADATA);

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(MOCK_MONGOOSE_CONNECTION.close).toBeCalledTimes(1);
  });

  test('Errors while generating cargo should be logged and end the call', async cb => {
    const err = new Error('Whoops');
    MOCK_FETCH_NODE_KEY.mockRejectedValue(err);
    CALL.metadata.add('Authorization', AUTHORIZATION_METADATA);

    CALL.on('error', async callError => {
      expect(MOCK_PINO.error).toBeCalledWith(
        { err, peerGatewayAddress: await CCA_SENDER_CERT.calculateSubjectPrivateAddress() },
        'Failed to send cargo',
      );

      expect(callError).toEqual({
        code: grpc.status.UNAVAILABLE,
        message: 'Internal server error; please try again later',
      });

      cb();
    });

    await SERVICE.collectCargo(CALL.convertToGrpcStream());
  });

  async function validateCargoDelivery(cargoDelivery: CargoDelivery): Promise<void> {
    expect(cargoDelivery).toHaveProperty('id', expect.stringMatching(/^[0-9a-f-]+$/));
    expect(cargoDelivery).toHaveProperty('cargo');
    const cargoMessageSet = await unwrapCargoMessages(cargoDelivery.cargo);
    expect(cargoMessageSet.messages).toHaveProperty('size', 1);
    expectBuffersToEqual(
      Array.from(cargoMessageSet.messages)[0],
      bufferToArray(DUMMY_PARCEL_SERIALIZED),
    );
  }

  async function unwrapCargoMessages(cargoSerialized: Buffer): Promise<CargoMessageSet> {
    const cargo = await Cargo.deserialize(bufferToArray(cargoSerialized));
    const { payload } = await cargo.unwrapPayload(CCA_SENDER_PRIVATE_KEY);
    return payload;
  }
});
