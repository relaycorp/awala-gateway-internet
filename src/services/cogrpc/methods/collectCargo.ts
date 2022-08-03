import * as grpc from '@grpc/grpc-js';
import { CargoDelivery, CargoDeliveryAck } from '@relaycorp/cogrpc';
import {
  CargoCollectionAuthorization,
  CargoCollectionRequest,
  CargoMessageStream,
  Certificate,
  CertificateRotation,
  CertificationPath,
  PrivateKeyStore,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { addDays } from 'date-fns';
import { Connection } from 'mongoose';
import { Logger } from 'pino';
import { pipeline } from 'streaming-iterables';
import uuid from 'uuid-random';

import { recordCCAFulfillment, wasCCAFulfilled } from '../../../ccaFulfilments';
import { MongoCertificateStore } from '../../../keystores/MongoCertificateStore';
import { PublicGatewayManager } from '../../../node/PublicGatewayManager';
import { generatePCAs } from '../../../parcelCollection';
import { ParcelObject, ParcelStore } from '../../../parcelStore';
import { issuePrivateGatewayCertificate } from '../../../pki';
import { Config, ConfigKey } from '../../../utilities/config';
import { INTERNAL_SERVER_ERROR } from '../grpcUtils';

export default async function collectCargo(
  call: grpc.ServerDuplexStream<CargoDeliveryAck, CargoDelivery>,
  mongooseConnection: Connection,
  parcelStore: ParcelStore,
  privateKeyStore: PrivateKeyStore,
  baseLogger: Logger,
): Promise<void> {
  const logger = baseLogger.child({
    grpcClient: call.getPeer(),
    grpcMethod: 'collectCargo',
  });
  const authorizationMetadata = call.metadata.get('Authorization');

  const ccaOrError = await parseCCAFromMetadata(authorizationMetadata);
  if (ccaOrError instanceof Error) {
    logger.info({ reason: ccaOrError.message }, 'Refusing malformed CCA');
    call.emit('error', {
      code: grpc.status.UNAUTHENTICATED,
      message: ccaOrError.message,
    });
    return;
  }

  const cca = ccaOrError;
  const peerGatewayAddress = await cca.senderCertificate.calculateSubjectId();
  const ccaAwareLogger = logger.child({ peerGatewayAddress });

  const config = new Config(mongooseConnection);
  const publicGatewayId = (await config.get(ConfigKey.CURRENT_ID))!!;
  const publicGatewayPrivateKey = await privateKeyStore.retrieveIdentityKey(publicGatewayId);
  const certificateStore = new MongoCertificateStore(mongooseConnection);
  const allCertificationPaths = await certificateStore.retrieveAll(
    publicGatewayId,
    publicGatewayId,
  );
  const allCertificates = allCertificationPaths.map((p) => p.leafCertificate);
  try {
    await cca.validate(allCertificates);
  } catch (err) {
    ccaAwareLogger.info({ ccaRecipient: cca.recipient, err }, 'Refusing invalid CCA');
    call.emit('error', {
      code: grpc.status.UNAUTHENTICATED,
      message: 'CCA is invalid',
    });
    return;
  }

  if (cca.recipient.id !== publicGatewayId) {
    ccaAwareLogger.info({ ccaRecipient: cca.recipient }, 'Refusing CCA bound for another gateway');
    call.emit('error', {
      code: grpc.status.INVALID_ARGUMENT,
      message: 'CCA recipient is a different gateway',
    });
    return;
  }

  const gatewayManager = await PublicGatewayManager.init(mongooseConnection);
  const gateway = await gatewayManager.getCurrent();

  let ccr: CargoCollectionRequest;
  try {
    ccr = await gateway.unwrapMessagePayload(cca);
  } catch (err) {
    ccaAwareLogger.info({ err }, 'Failed to extract Cargo Collection Request');
    call.emit('error', {
      code: grpc.status.UNAUTHENTICATED,
      message: 'Invalid CCA',
    });
    return;
  }

  if (await wasCCAFulfilled(cca, mongooseConnection)) {
    ccaAwareLogger.info('Refusing CCA that was already fulfilled');
    call.emit('error', {
      code: grpc.status.PERMISSION_DENIED,
      message: 'CCA was already fulfilled',
    });
    return;
  }

  let cargoesCollected = 0;
  const channel = await gateway.getChannel(
    ccr.cargoDeliveryAuthorization,
    await cca.senderCertificate.getPublicKey(),
  );

  async function* encapsulateMessagesInCargo(messages: CargoMessageStream): AsyncIterable<Buffer> {
    yield* await channel.generateCargoes(messages);
  }

  async function sendCargoes(cargoesSerialized: AsyncIterable<Buffer>): Promise<void> {
    for await (const cargoSerialized of cargoesSerialized) {
      // We aren't keeping the delivery ids because we're currently not doing anything with the ACKs
      // In the future we might use the ACKs to support back-pressure
      const delivery: CargoDelivery = { cargo: cargoSerialized, id: uuid() };
      call.write(delivery);
      cargoesCollected += 1;
    }
  }

  const cargoMessageStream = await generateCargoMessageStream(
    cca,
    peerGatewayAddress,
    parcelStore,
    mongooseConnection,
    publicGatewayPrivateKey!,
    (await certificateStore.retrieveLatest(publicGatewayId, publicGatewayId))!.leafCertificate,
    ccaAwareLogger,
  );
  try {
    await pipeline(() => cargoMessageStream, encapsulateMessagesInCargo, sendCargoes);
  } catch (err) {
    ccaAwareLogger.error({ err }, 'Failed to send cargo');
    call.emit('error', INTERNAL_SERVER_ERROR); // Also ends the call
    return;
  }

  await recordCCAFulfillment(cca, mongooseConnection);
  ccaAwareLogger.info({ cargoesCollected }, 'CCA was fulfilled successfully');
  call.end();
}

/**
 * Parse the CCA in `authorizationMetadata`, or return an error if malformed.
 *
 * We're returning an error instead of throwing it to distinguish validation errors from bugs.
 *
 * @param authorizationMetadata
 */
async function parseCCAFromMetadata(
  authorizationMetadata: readonly grpc.MetadataValue[],
): Promise<CargoCollectionAuthorization | Error> {
  if (authorizationMetadata.length !== 1) {
    return new Error('Authorization metadata should be specified exactly once');
  }

  const authorization = authorizationMetadata[0] as string;
  const [authorizationType, authorizationValue] = authorization.split(' ', 2);
  if (authorizationType !== 'Relaynet-CCA') {
    return new Error('Authorization type should be Relaynet-CCA');
  }
  if (authorizationValue === undefined) {
    return new Error('Authorization value should be set to the CCA');
  }

  const ccaSerialized = Buffer.from(authorizationValue, 'base64');
  try {
    return await CargoCollectionAuthorization.deserialize(bufferToArray(ccaSerialized));
  } catch (_) {
    return new Error('CCA is malformed');
  }
}

async function* generateCargoMessageStream(
  cca: CargoCollectionAuthorization,
  peerGatewayAddress: string,
  parcelStore: ParcelStore,
  mongooseConnection: Connection,
  publicGatewayPrivateKey: CryptoKey,
  publicGatewayCertificate: Certificate,
  ccaAwareLogger: Logger,
): CargoMessageStream {
  const activeParcels = pipeline(
    () => parcelStore.retrieveParcelsForPrivatePeer(peerGatewayAddress, ccaAwareLogger),
    convertParcelsToCargoMessageStream,
  );
  yield* await concatMessageStreams(
    generatePCAs(peerGatewayAddress, mongooseConnection),
    activeParcels,
  );

  const minCertTTL = addDays(new Date(), 90);
  if (cca.senderCertificate.expiryDate < minCertTTL) {
    ccaAwareLogger.info('Sending certificate rotation');
    const certificateRotation = await generateCertificateRotation(
      await cca.senderCertificate.getPublicKey(),
      publicGatewayPrivateKey,
      publicGatewayCertificate,
    );
    yield {
      expiryDate: certificateRotation.certificationPath.leafCertificate.expiryDate,
      message: Buffer.from(certificateRotation.serialize()),
    };
  } else {
    ccaAwareLogger.debug(
      { peerGatewayCertificateExpiry: cca.senderCertificate.expiryDate },
      'Skipping certificate rotation',
    );
  }
}

async function generateCertificateRotation(
  privateGatewayPublicKey: CryptoKey,
  publicGatewayPrivateKey: CryptoKey,
  publicGatewayCertificate: Certificate,
): Promise<CertificateRotation> {
  const privateGatewayCertificate = await issuePrivateGatewayCertificate(
    privateGatewayPublicKey,
    publicGatewayPrivateKey,
    publicGatewayCertificate,
  );
  return new CertificateRotation(
    new CertificationPath(privateGatewayCertificate, [publicGatewayCertificate]),
  );
}

async function* convertParcelsToCargoMessageStream(
  parcelObjects: AsyncIterable<ParcelObject<null>>,
): CargoMessageStream {
  for await (const parcelObject of parcelObjects) {
    yield { expiryDate: parcelObject.expiryDate, message: parcelObject.body };
  }
}

async function* concatMessageStreams(
  ...streams: readonly CargoMessageStream[]
): CargoMessageStream {
  for (const iterable of streams) {
    yield* await iterable;
  }
}
