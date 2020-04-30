/* tslint:disable:no-let */

import * as vaultKeystore from '@relaycorp/keystore-vault';
import { Cargo, CargoMessageSet, Parcel, RAMFSyntaxError } from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import * as stan from 'node-nats-streaming';

import { mockPino, mockSpy } from '../_test_utils';
import { NatsStreamingClient, PublisherMessage } from '../backingServices/natsStreaming';
import * as privateKeyStore from '../backingServices/privateKeyStore';
import {
  castMock,
  configureMockEnvVars,
  generateStubPdaChain,
  mockStanMessage,
  PdaChain,
} from './_test_utils';

const mockLogger = mockPino();
import { processIncomingCrcCargo } from './crcQueueWorker';

//region Stan-related fixtures

const STUB_NATS_SERVER = 'nats://example.com';
const STUB_NATS_CLUSTER_ID = 'nats-cluster-id';
const STUB_WORKER_NAME = 'worker-name';

let mockNatsClient: NatsStreamingClient;
let mockQueueMessages: readonly stan.Message[];
// tslint:disable-next-line:readonly-array
let mockPublishedMessages: Buffer[];
beforeEach(() => {
  mockQueueMessages = [];
  mockPublishedMessages = [];

  async function* mockMakePublisher(
    messages: AsyncIterable<PublisherMessage>,
  ): AsyncIterable<string> {
    for await (const message of messages) {
      mockPublishedMessages.push(message.data as Buffer);
      yield message.id;
    }
  }

  async function* mockMakeQueueConsumer(): AsyncIterable<stan.Message> {
    for (const message of mockQueueMessages) {
      yield message;
    }
  }

  mockNatsClient = castMock<NatsStreamingClient>({
    disconnect: jest.fn(),
    makePublisher: jest.fn().mockReturnValue(mockMakePublisher),
    makeQueueConsumer: jest.fn().mockImplementation(mockMakeQueueConsumer),
  });
});
mockSpy(jest.spyOn(NatsStreamingClient, 'initFromEnv'), () => mockNatsClient);

//region Keystore-related fixtures

const STUB_VAULT_URL = 'https://vault.com';
const STUB_VAULT_TOKEN = 'letmein';
const STUB_VAULT_KV_PREFIX = 'keys/';

const mockPrivateKeyStore = castMock<vaultKeystore.VaultPrivateKeyStore>({});
mockSpy(jest.spyOn(privateKeyStore, 'initVaultKeyStore'), () => mockPrivateKeyStore);

//endregion

const BASE_ENV_VARS = {
  NATS_CLUSTER_ID: STUB_NATS_CLUSTER_ID,
  NATS_SERVER_URL: STUB_NATS_SERVER,
  VAULT_KV_PREFIX: STUB_VAULT_KV_PREFIX,
  VAULT_TOKEN: STUB_VAULT_TOKEN,
  VAULT_URL: STUB_VAULT_URL,
};
configureMockEnvVars(BASE_ENV_VARS);

const mockCargoUnwrapPayload = mockSpy(
  jest.spyOn(Cargo.prototype, 'unwrapPayload'),
  () => new CargoMessageSet(new Set()),
);

describe('processIncomingCrcCargo', () => {
  let stubPdaChain: PdaChain;
  beforeAll(async () => {
    stubPdaChain = await generateStubPdaChain();
  });

  describe('Queue subscription', () => {
    test('Worker should subscribe to channel "crc-cargo"', async () => {
      await processIncomingCrcCargo(STUB_WORKER_NAME);

      expect(mockNatsClient.makeQueueConsumer).toBeCalledWith(
        'crc-cargo',
        expect.anything(),
        expect.anything(),
      );
    });

    test('Subscription should use queue "worker"', async () => {
      await processIncomingCrcCargo(STUB_WORKER_NAME);

      expect(mockNatsClient.makeQueueConsumer).toBeCalledWith(
        expect.anything(),
        'worker',
        expect.anything(),
      );
    });

    test('Subscription should use durable name "worker"', async () => {
      await processIncomingCrcCargo(STUB_WORKER_NAME);

      expect(mockNatsClient.makeQueueConsumer).toBeCalledWith(
        expect.anything(),
        expect.anything(),
        'worker',
      );
    });
  });

  test('Parcels contained in cargo should be published on channel "crc-parcels"', async () => {
    const stubParcel = new Parcel('recipient-address', stubPdaChain.pdaCert, Buffer.from('hi'));
    const stubParcelSerialized = await stubParcel.serialize(stubPdaChain.pdaGranteePrivateKey);
    const stubCargoMessageSet = new CargoMessageSet(new Set([stubParcelSerialized]));
    mockQueueMessages = [mockStanMessage(await generateCargo(stubCargoMessageSet))];

    mockCargoUnwrapPayload.mockResolvedValueOnce({ payload: stubCargoMessageSet });

    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(mockCargoUnwrapPayload).toBeCalledTimes(1);
    expect(mockCargoUnwrapPayload).toBeCalledWith(mockPrivateKeyStore);

    expect(mockNatsClient.makePublisher).toBeCalledTimes(1);
    expect(mockNatsClient.makePublisher).toBeCalledWith('crc-parcels');
    expect(mockPublishedMessages.map(bufferToArray)).toEqual([stubParcelSerialized]);
  });

  test('Cargo containing invalid messages should be ignored and logged', async () => {
    // First cargo contains an invalid messages followed by a valid. The second cargo contains
    // one message and it's valid.

    const stubParcel1 = new Parcel('recipient-address', stubPdaChain.pdaCert, Buffer.from('hi'));
    const stubParcel1Serialized = await stubParcel1.serialize(stubPdaChain.pdaGranteePrivateKey);
    const stubParcel2 = new Parcel('recipient-address', stubPdaChain.pdaCert, Buffer.from('hi'));
    const stubParcel2Serialized = await stubParcel2.serialize(stubPdaChain.pdaGranteePrivateKey);
    const stubCargo1MessageSet = new CargoMessageSet(
      new Set([Buffer.from('Not a parcel'), stubParcel1Serialized]),
    );
    const stubCargo1 = new Cargo(
      await stubPdaChain.publicGatewayCert.getCommonName(),
      stubPdaChain.privateGatewayCert,
      Buffer.from(stubCargo1MessageSet.serialize()),
    );

    const stubCargo2MessageSet = new CargoMessageSet(new Set([stubParcel2Serialized]));
    mockQueueMessages = [
      mockStanMessage(await stubCargo1.serialize(stubPdaChain.privateGatewayPrivateKey)),
      mockStanMessage(await generateCargo(stubCargo2MessageSet)),
    ];

    mockCargoUnwrapPayload.mockResolvedValueOnce({ payload: stubCargo1MessageSet });
    mockCargoUnwrapPayload.mockResolvedValueOnce({ payload: stubCargo2MessageSet });

    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(mockPublishedMessages.map(bufferToArray)).toEqual([
      stubParcel1Serialized,
      stubParcel2Serialized,
    ]);

    const cargoSenderAddress = await stubCargo1.senderCertificate.calculateSubjectPrivateAddress();
    expect(mockLogger.info).toBeCalledWith(
      {
        cargoId: stubCargo1.id,
        error: expect.any(RAMFSyntaxError),
        senderAddress: cargoSenderAddress,
      },
      `Cargo contains an invalid message`,
    );
  });

  test('Cargo message should be acknowledged after messages have been processed', async () => {
    const stubParcel = new Parcel('recipient-address', stubPdaChain.pdaCert, Buffer.from('hi'));
    const stubParcelSerialized = Buffer.from(
      await stubParcel.serialize(stubPdaChain.pdaGranteePrivateKey),
    );
    const stubCargoMessageSet = new CargoMessageSet(new Set([stubParcelSerialized]));
    const stanMessage = mockStanMessage(await generateCargo(stubCargoMessageSet));
    mockQueueMessages = [stanMessage];

    mockCargoUnwrapPayload.mockResolvedValueOnce({ payload: stubCargoMessageSet });

    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(stanMessage.ack).toBeCalledTimes(1);
    expect(stanMessage.ack).toBeCalledWith();
  });

  test('NATS connection should be closed upon successful completion', async () => {
    await processIncomingCrcCargo(STUB_WORKER_NAME);

    expect(mockNatsClient.disconnect).toBeCalledTimes(1);
    expect(mockNatsClient.disconnect).toBeCalledWith();
  });

  test('NATS connection should be closed upon error', async () => {
    const error = new Error('Not on my watch');
    // @ts-ignore
    mockNatsClient.makePublisher.mockReturnValue(() => {
      throw error;
    });

    await expect(processIncomingCrcCargo(STUB_WORKER_NAME)).rejects.toEqual(error);

    expect(mockNatsClient.disconnect).toBeCalledTimes(1);
    expect(mockNatsClient.disconnect).toBeCalledWith();
  });

  async function generateCargo(cargoMessageSet: CargoMessageSet): Promise<ArrayBuffer> {
    const stubCargo = new Cargo(
      await stubPdaChain.publicGatewayCert.getCommonName(),
      stubPdaChain.privateGatewayCert,
      Buffer.from(cargoMessageSet.serialize()),
    );
    return stubCargo.serialize(stubPdaChain.privateGatewayPrivateKey);
  }
});
