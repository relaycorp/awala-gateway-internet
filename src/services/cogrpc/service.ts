import {
  CargoDelivery,
  CargoDeliveryAck,
  CargoRelayServerMethodSet,
} from '@relaycorp/relaynet-cogrpc';
import { Cargo, CargoCollectionAuthorization } from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import * as grpc from 'grpc';
import pipe from 'it-pipe';
import { createConnection } from 'mongoose';
import * as streamToIt from 'stream-to-it';
import uuid from 'uuid-random';

import { NatsStreamingClient, PublisherMessage } from '../../backingServices/natsStreaming';
import { retrieveOwnCertificates } from '../certs';

interface ServiceImplementationOptions {
  readonly cogrpcAddress: string;
  readonly mongoUri: string;
  readonly natsServerUrl: string;
  readonly natsClusterId: string;
}

export function makeServiceImplementation(
  options: ServiceImplementationOptions,
): CargoRelayServerMethodSet {
  return {
    async deliverCargo(
      call: grpc.ServerDuplexStream<CargoDelivery, CargoDeliveryAck>,
    ): Promise<void> {
      const mongooseConnection = createConnection(options.mongoUri);
      const trustedCerts = await retrieveOwnCertificates(mongooseConnection);
      await mongooseConnection.close();

      call.on('end', () => {
        call.end();
      });

      const natsClient = new NatsStreamingClient(
        options.natsServerUrl,
        options.natsClusterId,
        `cogrpc-${uuid()}`,
      );
      const natsPublisher = natsClient.makePublisher('crc-cargo');

      async function* validateDelivery(
        source: AsyncIterable<CargoDelivery>,
      ): AsyncIterable<PublisherMessage> {
        for await (const delivery of source) {
          try {
            const cargo = await Cargo.deserialize(delivery.cargo);
            await cargo.validate(trustedCerts);
          } catch (error) {
            // Acknowledge that we got it, not that it was accepted and stored. See:
            // https://github.com/relaynet/specs/issues/38
            call.write({ id: delivery.id });
            continue;
          }
          yield { id: delivery.id, data: delivery.cargo };
        }
      }

      async function ackDelivery(source: AsyncIterable<string>): Promise<void> {
        for await (const deliveryId of source) {
          call.write({ id: deliveryId });
        }
      }

      try {
        await pipe(streamToIt.source(call), validateDelivery, natsPublisher, ackDelivery);
      } finally {
        natsClient.disconnect();
      }
    },
    async collectCargo(
      call: grpc.ServerDuplexStream<CargoDeliveryAck, CargoDelivery>,
    ): Promise<void> {
      return collectCargo(call, options.cogrpcAddress);
    },
  };
}

export async function collectCargo(
  call: grpc.ServerDuplexStream<CargoDeliveryAck, CargoDelivery>,
  ownCogrpcAddress: string,
): Promise<void> {
  const authorizationMetadata = call.metadata.get('Authorization');

  try {
    await parseAndValidateCCAFromMetadata(authorizationMetadata, ownCogrpcAddress);
  } catch (error) {
    call.emit('error', {
      code: grpc.status.UNAUTHENTICATED,
      message: error.message,
    });
    return;
  }

  call.end();
}

async function parseAndValidateCCAFromMetadata(
  authorizationMetadata: readonly grpc.MetadataValue[],
  expectedTargetGatewayAddress: string,
): Promise<CargoCollectionAuthorization> {
  if (authorizationMetadata.length !== 1) {
    throw new Error('Authorization metadata should be specified exactly once');
  }

  const authorization = authorizationMetadata[0] as string;
  const [authorizationType, authorizationValue] = authorization.split(' ', 2);
  if (authorizationType !== 'Relaynet-CCA') {
    throw new Error('Authorization type should be Relaynet-CCA');
  }
  if (authorizationValue === undefined) {
    throw new Error('Authorization value should be set to the CCA');
  }

  const ccaSerialized = Buffer.from(authorizationValue, 'base64');
  // tslint:disable-next-line:no-let
  let cca: CargoCollectionAuthorization;
  try {
    cca = await CargoCollectionAuthorization.deserialize(bufferToArray(ccaSerialized));
  } catch (_) {
    throw new Error('CCA is malformed');
  }

  if (cca.recipientAddress !== expectedTargetGatewayAddress) {
    throw new Error('CCA recipient is a different gateway');
  }

  return cca;
}
