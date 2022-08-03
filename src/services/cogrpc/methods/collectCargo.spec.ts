import * as grpc from '@grpc/grpc-js';
import { CargoDelivery, CargoDeliveryAck, CargoRelayServerMethodSet } from '@relaycorp/cogrpc';
import {
  Cargo,
  CargoCollectionAuthorization,
  CargoMessageSet,
  CargoMessageStream,
  CertificateRotation,
  CertificationPath,
  derSerializePublicKey,
  generateRSAKeyPair,
  InvalidMessageError,
  issueEndpointCertificate,
  Parcel,
  ParcelCollectionAck,
  SessionEnvelopedData,
  SessionKeyPair,
  UnknownKeyError,
} from '@relaycorp/relaynet-core';
import {
  CDACertPath,
  generateCDACertificationPath,
  generateIdentityKeyPairSet,
  generatePDACertificationPath,
  NodeKeyPairSet,
  PDACertPath,
} from '@relaycorp/relaynet-testing';
import bufferToArray from 'buffer-to-arraybuffer';
import { addDays, addSeconds, subSeconds } from 'date-fns';

import { recordCCAFulfillment, wasCCAFulfilled } from '../../../ccaFulfilments';
import { MongoCertificateStore } from '../../../keystores/MongoCertificateStore';
import * as parcelCollectionAck from '../../../parcelCollection';
import { ParcelStore } from '../../../parcelStore';
import { GATEWAY_INTERNET_ADDRESS } from '../../../testUtils/awala';
import { arrayBufferFrom } from '../../../testUtils/buffers';
import { UUID4_REGEX } from '../../../testUtils/crypto';
import { catchErrorEvent } from '../../../testUtils/errors';
import { MockGrpcBidiCall } from '../../../testUtils/grpc';
import { arrayToAsyncIterable } from '../../../testUtils/iter';
import { mockSpy } from '../../../testUtils/jest';
import { partialPinoLog, partialPinoLogger } from '../../../testUtils/logging';
import { generateCCA } from '../../../testUtils/pki';
import { Config, ConfigKey } from '../../../utilities/config';
import { setUpTestEnvironment, STUB_OBJECT_STORE_BUCKET } from '../_test_utils';
import { makeService } from '../service';

const TOMORROW = addDays(new Date(), 1);

let keyPairSet: NodeKeyPairSet;
let pdaChain: PDACertPath;
let cdaChain: CDACertPath;
let publicGatewayId: string;
let privateGatewayPrivateAddress: string;
beforeAll(async () => {
  keyPairSet = await generateIdentityKeyPairSet();
  pdaChain = await generatePDACertificationPath(keyPairSet, addDays(new Date(), 181));
  cdaChain = await generateCDACertificationPath(keyPairSet);
  publicGatewayId = await pdaChain.publicGateway.calculateSubjectId();
  privateGatewayPrivateAddress = await pdaChain.privateGateway.calculateSubjectId();
});

const { getMongooseConnection, getSvcImplOptions, getMockLogs, getPrivateKeystore } =
  setUpTestEnvironment();

let publicGatewaySessionKeyPair: SessionKeyPair;
beforeAll(async () => {
  publicGatewaySessionKeyPair = await SessionKeyPair.generate();
});
beforeEach(async () => {
  const privateKeyStore = getPrivateKeystore();
  await privateKeyStore.saveIdentityKey(publicGatewayId, keyPairSet.publicGateway.privateKey);
  await privateKeyStore.saveSessionKey(
    publicGatewaySessionKeyPair.privateKey,
    publicGatewaySessionKeyPair.sessionKey.keyId,
    publicGatewayId,
    privateGatewayPrivateAddress,
  );
});

beforeEach(async () => {
  const connection = getMongooseConnection();

  const certificateStore = new MongoCertificateStore(connection);
  await certificateStore.save(new CertificationPath(pdaChain.publicGateway, []), publicGatewayId);

  const config = new Config(connection);
  await config.set(ConfigKey.CURRENT_ID, await pdaChain.publicGateway.calculateSubjectId());
});

let SERVICE: CargoRelayServerMethodSet;
beforeEach(async () => {
  SERVICE = await makeService(getSvcImplOptions());
});

let CALL: MockGrpcBidiCall<CargoDelivery, CargoDeliveryAck>;
beforeEach(() => {
  CALL = new MockGrpcBidiCall();
});

const MOCK_RETRIEVE_ACTIVE_PARCELS = mockSpy(
  jest.spyOn(ParcelStore.prototype, 'retrieveParcelsForPrivatePeer'),
  () => arrayToAsyncIterable([]),
);
const MOCK_GENERATE_PCAS = mockSpy(
  jest.spyOn(parcelCollectionAck, 'generatePCAs'),
  async function* (): CargoMessageStream {
    yield* arrayToAsyncIterable([]);
  },
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
    { id: await certificate.calculateSubjectId() },
    certificate,
    Buffer.from('Pretend this is a CMS EnvelopedData value'),
  );
  DUMMY_PARCEL_SERIALIZED = Buffer.from(await DUMMY_PARCEL.serialize(keyPair.privateKey));
});

let cca: CargoCollectionAuthorization;
let ccaSerialized: Buffer;
let privateGatewaySessionPrivateKey: CryptoKey;
beforeAll(async () => {
  const generatedCCA = await generateCCA(
    { id: publicGatewayId, internetAddress: GATEWAY_INTERNET_ADDRESS },
    publicGatewaySessionKeyPair.sessionKey,
    cdaChain.publicGateway,
    pdaChain.privateGateway,
    keyPairSet.privateGateway.privateKey,
  );
  cca = generatedCCA.cca;
  ccaSerialized = generatedCCA.ccaSerialized;
  privateGatewaySessionPrivateKey = generatedCCA.sessionPrivateKey;
});

describe('CCA validation', () => {
  test('UNAUTHENTICATED should be returned if Authorization is missing', async () => {
    const error = await catchErrorEvent(CALL, () =>
      SERVICE.collectCargo(CALL.convertToGrpcStream()),
    );

    const errorMessage = 'Authorization metadata should be specified exactly once';
    expect(getMockLogs()).toContainEqual(invalidCCALog(errorMessage));
    expect(error).toEqual({
      code: grpc.status.UNAUTHENTICATED,
      message: errorMessage,
    });
  });

  test('UNAUTHENTICATED should be returned if Authorization is duplicated', async () => {
    CALL.metadata.add('Authorization', 'Bearer s3cr3t');
    CALL.metadata.add('Authorization', 'Bearer s3cr3t');

    const error = await catchErrorEvent(CALL, () =>
      SERVICE.collectCargo(CALL.convertToGrpcStream()),
    );

    const errorMessage = 'Authorization metadata should be specified exactly once';
    expect(getMockLogs()).toContainEqual(invalidCCALog(errorMessage));
    expect(error).toEqual({
      code: grpc.status.UNAUTHENTICATED,
      message: errorMessage,
    });
  });

  test('UNAUTHENTICATED should be returned if Authorization type is invalid', async () => {
    CALL.metadata.add('Authorization', 'Bearer s3cr3t');

    const error = await catchErrorEvent(CALL, () =>
      SERVICE.collectCargo(CALL.convertToGrpcStream()),
    );

    const errorMessage = 'Authorization type should be Relaynet-CCA';
    expect(getMockLogs()).toContainEqual(invalidCCALog(errorMessage));
    expect(error).toEqual({
      code: grpc.status.UNAUTHENTICATED,
      message: errorMessage,
    });
  });

  test('UNAUTHENTICATED should be returned if Authorization value is missing', async () => {
    CALL.metadata.add('Authorization', 'Relaynet-CCA');

    const error = await catchErrorEvent(CALL, () =>
      SERVICE.collectCargo(CALL.convertToGrpcStream()),
    );

    const errorMessage = 'Authorization value should be set to the CCA';
    expect(getMockLogs()).toContainEqual(invalidCCALog(errorMessage));
    expect(error).toEqual({
      code: grpc.status.UNAUTHENTICATED,
      message: errorMessage,
    });
  });

  test('UNAUTHENTICATED should be returned if CCA is malformed', async () => {
    const invalidCCASerialized = Buffer.from('I am not really a RAMF message');
    CALL.metadata.add('Authorization', serializeAuthzMetadata(invalidCCASerialized));

    const error = await catchErrorEvent(CALL, () =>
      SERVICE.collectCargo(CALL.convertToGrpcStream()),
    );

    const errorMessage = 'CCA is malformed';
    expect(getMockLogs()).toContainEqual(invalidCCALog(errorMessage));
    expect(error).toEqual({
      code: grpc.status.UNAUTHENTICATED,
      message: errorMessage,
    });
  });

  test('UNAUTHENTICATED should be returned if payload is not an EnvelopedData value', async () => {
    const invalidCCASerialized = await generateCCAForPayload(
      GATEWAY_INTERNET_ADDRESS,
      new ArrayBuffer(0),
    );
    CALL.metadata.add('Authorization', serializeAuthzMetadata(invalidCCASerialized));

    const error = await catchErrorEvent(CALL, () =>
      SERVICE.collectCargo(CALL.convertToGrpcStream()),
    );

    expect(getMockLogs()).toContainEqual(invalidCCRLog('CMSError'));
    expect(error).toEqual({
      code: grpc.status.UNAUTHENTICATED,
      message: 'Invalid CCA',
    });
  });

  test('UNAUTHENTICATED should be returned if EnvelopedData cannot be decrypted', async () => {
    const unknownSessionKey = (await SessionKeyPair.generate()).sessionKey;
    const { envelopedData } = await SessionEnvelopedData.encrypt(
      new ArrayBuffer(0),
      unknownSessionKey, // The public gateway doesn't have this key
    );
    const invalidCCASerialized = await generateCCAForPayload(
      GATEWAY_INTERNET_ADDRESS,
      envelopedData.serialize(),
    );
    CALL.metadata.add('Authorization', serializeAuthzMetadata(invalidCCASerialized));

    const error = await catchErrorEvent(CALL, () =>
      SERVICE.collectCargo(CALL.convertToGrpcStream()),
    );

    expect(getMockLogs()).toContainEqual(invalidCCRLog(UnknownKeyError.name));
    expect(error).toEqual({
      code: grpc.status.UNAUTHENTICATED,
      message: 'Invalid CCA',
    });
  });

  test('UNAUTHENTICATED should be returned if CCR is malformed', async () => {
    const { envelopedData } = await SessionEnvelopedData.encrypt(
      arrayBufferFrom('not a valid CCR'),
      publicGatewaySessionKeyPair.sessionKey,
    );
    const invalidCCASerialized = await generateCCAForPayload(
      GATEWAY_INTERNET_ADDRESS,
      envelopedData.serialize(),
    );
    CALL.metadata.add('Authorization', serializeAuthzMetadata(invalidCCASerialized));

    const error = await catchErrorEvent(CALL, () =>
      SERVICE.collectCargo(CALL.convertToGrpcStream()),
    );

    expect(getMockLogs()).toContainEqual(invalidCCRLog(InvalidMessageError.name));
    expect(error).toEqual({
      code: grpc.status.UNAUTHENTICATED,
      message: 'Invalid CCA',
    });
  });

  test('INVALID_ARGUMENT should be returned if CCA recipient address is private', async () => {
    const malformedCCA = new CargoCollectionAuthorization(
      { id: '0deadbeef' },
      pdaChain.privateGateway,
      Buffer.from([]),
    );
    const invalidCCASerialized = Buffer.from(
      await malformedCCA.serialize(keyPairSet.privateGateway.privateKey),
    );
    CALL.metadata.add('Authorization', serializeAuthzMetadata(invalidCCASerialized));

    const error = await catchErrorEvent(CALL, () =>
      SERVICE.collectCargo(CALL.convertToGrpcStream()),
    );

    expect(getMockLogs()).toContainEqual(
      partialPinoLog('info', 'Refusing invalid CCA', {
        ccaRecipient: malformedCCA.recipient,
        grpcClient: CALL.getPeer(),
        grpcMethod: 'collectCargo',
        peerGatewayAddress: privateGatewayPrivateAddress,
      }),
    );
    expect(error).toEqual({
      code: grpc.status.UNAUTHENTICATED,
      message: 'CCA is invalid',
    });
  });

  test('INVALID_ARGUMENT should be returned if CCA is not bound for current gateway', async () => {
    const invalidCCA = new CargoCollectionAuthorization(
      { id: '0deadbeef', internetAddress: `not-${GATEWAY_INTERNET_ADDRESS}` },
      pdaChain.privateGateway,
      Buffer.from([]),
    );
    const invalidCCASerialized = Buffer.from(
      await invalidCCA.serialize(keyPairSet.privateGateway.privateKey),
    );
    CALL.metadata.add('Authorization', serializeAuthzMetadata(invalidCCASerialized));

    const error = await catchErrorEvent(CALL, () =>
      SERVICE.collectCargo(CALL.convertToGrpcStream()),
    );

    expect(getMockLogs()).toContainEqual(
      partialPinoLog('info', 'Refusing CCA bound for another gateway', {
        ccaRecipient: invalidCCA.recipient,
        grpcClient: CALL.getPeer(),
        grpcMethod: 'collectCargo',
        peerGatewayAddress: privateGatewayPrivateAddress,
      }),
    );
    expect(error).toEqual({
      code: grpc.status.INVALID_ARGUMENT,
      message: 'CCA recipient is a different gateway',
    });
  });

  test('PERMISSION_DENIED should be returned if CCA sender is unauthorized', async () => {
    const ccaSenderCertificate = pdaChain.pdaGrantee;
    const invalidCCA = new CargoCollectionAuthorization(
      { id: '0deadbeef', internetAddress: GATEWAY_INTERNET_ADDRESS },
      ccaSenderCertificate,
      Buffer.from([]),
    );
    const invalidCCASerialized = await invalidCCA.serialize(keyPairSet.pdaGrantee.privateKey);
    CALL.metadata.add('Authorization', serializeAuthzMetadata(invalidCCASerialized));

    const error = await catchErrorEvent(CALL, () =>
      SERVICE.collectCargo(CALL.convertToGrpcStream()),
    );

    expect(getMockLogs()).toContainEqual(
      partialPinoLog('info', 'Refusing invalid CCA', {
        err: expect.objectContaining({ type: InvalidMessageError.name }),
        grpcClient: CALL.getPeer(),
        grpcMethod: 'collectCargo',
        peerGatewayAddress: await ccaSenderCertificate.calculateSubjectId(),
      }),
    );
    expect(error).toEqual({
      code: grpc.status.UNAUTHENTICATED,
      message: 'CCA is invalid',
    });
  });

  test('PERMISSION_DENIED should be returned if CCA was already fulfilled', async () => {
    await recordCCAFulfillment(cca, getMongooseConnection());
    CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

    const error = await catchErrorEvent(CALL, () =>
      SERVICE.collectCargo(CALL.convertToGrpcStream()),
    );

    expect(getMockLogs()).toContainEqual(
      partialPinoLog('info', 'Refusing CCA that was already fulfilled', {
        grpcClient: CALL.getPeer(),
        grpcMethod: 'collectCargo',
        peerGatewayAddress: privateGatewayPrivateAddress,
      }),
    );
    expect(error).toEqual({
      code: grpc.status.PERMISSION_DENIED,
      message: 'CCA was already fulfilled',
    });
  });

  function invalidCCALog(errorMessage: string): ReturnType<typeof partialPinoLog> {
    return partialPinoLog('info', 'Refusing malformed CCA', {
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
    STUB_OBJECT_STORE_BUCKET,
  );
});

test('Parcels retrieved should be limited to sender of CCA', async () => {
  CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

  await SERVICE.collectCargo(CALL.convertToGrpcStream());

  expect(MOCK_RETRIEVE_ACTIVE_PARCELS).toBeCalledWith(
    privateGatewayPrivateAddress,
    partialPinoLogger({ peerGatewayAddress: privateGatewayPrivateAddress }) as any,
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
  expect(getMockLogs()).toContainEqual(
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
    await pdaChain.privateGateway.calculateSubjectId(),
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
  await cargo.validate([cdaChain.privateGateway]);
});

test('CCA should be logged as fulfilled to make sure it is only used once', async () => {
  CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

  await SERVICE.collectCargo(CALL.convertToGrpcStream());

  await expect(wasCCAFulfilled(cca, getMongooseConnection())).resolves.toBeTrue();
});

test('CCA fulfillment should be logged and end the call', async () => {
  CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

  await SERVICE.collectCargo(CALL.convertToGrpcStream());

  expect(getMockLogs()).toContainEqual(
    partialPinoLog('info', 'CCA was fulfilled successfully', {
      cargoesCollected: 0,
      grpcClient: CALL.getPeer(),
      grpcMethod: 'collectCargo',
      peerGatewayAddress: privateGatewayPrivateAddress,
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
  const { messages } = await unwrapCargoMessages(CALL.input[0].cargo);
  expect(messages).toHaveLength(1);
});

describe('Private gateway certificate rotation', () => {
  const PRIVATE_GATEWAY_MIN_TTL_DAYS = 90;

  test('Rotation message should be included if certificate expires within 90 days', async () => {
    const cutoffDate = addDays(new Date(), PRIVATE_GATEWAY_MIN_TTL_DAYS);
    const expiringPDAChain = await generatePDACertificationPath(
      keyPairSet,
      subSeconds(cutoffDate, 1),
    );
    const { ccaSerialized: expiringCCA, sessionPrivateKey } = await generateCCA(
      { id: publicGatewayId, internetAddress: GATEWAY_INTERNET_ADDRESS },
      publicGatewaySessionKeyPair.sessionKey,
      cdaChain.publicGateway,
      expiringPDAChain.privateGateway,
      keyPairSet.privateGateway.privateKey,
    );
    CALL.metadata.add('Authorization', serializeAuthzMetadata(expiringCCA));

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    const cargo = await Cargo.deserialize(bufferToArray(CALL.input[0].cargo));
    const cargoUnwrap = await cargo.unwrapPayload(sessionPrivateKey);
    const rotation = CertificateRotation.deserialize(cargoUnwrap.payload.messages[0]);
    // Check private gateway certificate
    await expect(
      derSerializePublicKey(await rotation.certificationPath.leafCertificate.getPublicKey()),
    ).resolves.toEqual(await derSerializePublicKey(await pdaChain.privateGateway.getPublicKey()));
    await expect(
      rotation.certificationPath.leafCertificate.getCertificationPath([], [pdaChain.publicGateway]),
    ).resolves.toHaveLength(2);
    // Check public gateway certificate
    expect(rotation.certificationPath.certificateAuthorities).toHaveLength(1);
    expect(
      pdaChain.publicGateway.isEqual(rotation.certificationPath.certificateAuthorities[0]),
    ).toBeTrue();
    // Other checks
    expect(getMockLogs()).toContainEqual(
      partialPinoLog('info', 'Sending certificate rotation', {
        grpcMethod: 'collectCargo',
        peerGatewayAddress: privateGatewayPrivateAddress,
      }),
    );
  });

  test('Rotation message should not be included if certificate has more than 90 days', async () => {
    const cutoffDate = addDays(new Date(), PRIVATE_GATEWAY_MIN_TTL_DAYS);
    const expiringPDAChain = await generatePDACertificationPath(
      keyPairSet,
      addSeconds(cutoffDate, 10),
    );
    const { ccaSerialized: expiringCCA } = await generateCCA(
      { id: publicGatewayId, internetAddress: GATEWAY_INTERNET_ADDRESS },
      publicGatewaySessionKeyPair.sessionKey,
      cdaChain.publicGateway,
      expiringPDAChain.privateGateway,
      keyPairSet.privateGateway.privateKey,
    );
    CALL.metadata.add('Authorization', serializeAuthzMetadata(expiringCCA));

    await SERVICE.collectCargo(CALL.convertToGrpcStream());

    expect(CALL.input).toHaveLength(0);
    expect(getMockLogs()).toContainEqual(
      partialPinoLog('debug', 'Skipping certificate rotation', {
        grpcMethod: 'collectCargo',
        peerGatewayAddress: privateGatewayPrivateAddress,
        peerGatewayCertificateExpiry: expiringPDAChain.privateGateway.expiryDate.toISOString(),
      }),
    );
  });
});

describe('Errors while generating cargo', () => {
  const err = new Error('Whoops');
  beforeEach(() => {
    MOCK_RETRIEVE_ACTIVE_PARCELS.mockImplementation(async function* (): AsyncIterable<any> {
      throw err;
    });
    CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));
  });

  test('Error should be logged and end the call', async () => {
    await catchErrorEvent(CALL, () => SERVICE.collectCargo(CALL.convertToGrpcStream()));

    expect(getMockLogs()).toContainEqual(
      partialPinoLog('error', 'Failed to send cargo', {
        err: expect.objectContaining({ message: err.message }),
        grpcClient: CALL.getPeer(),
        grpcMethod: 'collectCargo',
        peerGatewayAddress: privateGatewayPrivateAddress,
      }),
    );
  });

  test('Call should end with an error for the client', async () => {
    const callError = await catchErrorEvent(CALL, () =>
      SERVICE.collectCargo(CALL.convertToGrpcStream()),
    );

    expect(callError).toEqual({
      code: grpc.status.UNAVAILABLE,
      message: 'Internal server error; please try again later',
    });
  });

  test('CCA should not be marked as fulfilled', async () => {
    await catchErrorEvent(CALL, () => SERVICE.collectCargo(CALL.convertToGrpcStream()));

    await expect(wasCCAFulfilled(cca, getMongooseConnection())).resolves.toBeFalse();
  });
});

function serializeAuthzMetadata(ccaSerialization: Buffer | ArrayBuffer): string {
  const ccaHexSerialization = Buffer.from(ccaSerialization).toString('base64');
  return `Relaynet-CCA ${ccaHexSerialization}`;
}

async function generateCCAForPayload(recipientId: string, payload: ArrayBuffer): Promise<Buffer> {
  const auth = new CargoCollectionAuthorization(
    { id: recipientId, internetAddress: GATEWAY_INTERNET_ADDRESS },
    pdaChain.privateGateway,
    Buffer.from(payload),
  );
  return Buffer.from(await auth.serialize(keyPairSet.privateGateway.privateKey));
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
