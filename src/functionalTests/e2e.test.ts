import { CogRPCClient } from '@relaycorp/cogrpc';
import {
  ParcelCollectionAck,
  ParcelCollectionHandshakeSigner,
  ParcelDeliverySigner,
  StreamingMode,
} from '@relaycorp/relaynet-core';
import { PoWebClient } from '@relaycorp/relaynet-poweb';
import { pipeline } from 'streaming-iterables';
import uuid from 'uuid-random';

import { arrayToAsyncIterable, asyncIterableToArray, iterableTake } from '../testUtils/iter';
import { generateCCA, generateCDAChain } from '../testUtils/pki';
import { createAndRegisterPrivateGateway } from './utils/gatewayRegistration';
import {
  GW_COGRPC_HOST_URL,
  GW_INTERNET_ADDRESS,
  GW_POWEB_HOST_PORT,
  IS_GITHUB,
} from './utils/constants';
import { sleep } from './utils/timing';
import { encapsulateMessagesInCargo, extractMessagesFromCargo } from './utils/cargo';
import { deserializePong, makePingParcel } from './utils/ping';

test('Sending pings via PoWeb and receiving pongs via PoHTTP', async () => {
  const powebClient = PoWebClient.initLocal(GW_POWEB_HOST_PORT);
  const { pdaChain } = await createAndRegisterPrivateGateway();

  const pingId = uuid();
  const pingParcelData = await makePingParcel(pingId, pdaChain);

  // Deliver the ping message
  await powebClient.deliverParcel(
    pingParcelData.parcelSerialized,
    new ParcelDeliverySigner(pdaChain.privateGatewayCert, pdaChain.privateGatewayPrivateKey),
  );

  // Collect the pong message once it's been received
  const incomingParcels = await pipeline(
    () =>
      powebClient.collectParcels(
        [
          new ParcelCollectionHandshakeSigner(
            pdaChain.privateGatewayCert,
            pdaChain.privateGatewayPrivateKey,
          ),
        ],
        StreamingMode.KEEP_ALIVE,
      ),
    async function* (collections): AsyncIterable<ArrayBuffer> {
      for await (const collection of collections) {
        yield collection.parcelSerialized;
        await collection.ack();
      }
    },
    iterableTake(1),
    asyncIterableToArray,
  );
  expect(incomingParcels).toHaveLength(1);

  await expect(deserializePong(incomingParcels[0], pingParcelData.sessionKey)).resolves.toEqual(
    pingId,
  );
});

test('Sending pings via CogRPC and receiving pongs via PoHTTP', async () => {
  const { pdaChain, publicGatewaySessionKey } = await createAndRegisterPrivateGateway();

  const pingId = uuid();
  const pingParcelData = await makePingParcel(pingId, pdaChain);

  const cogRPCClient = await CogRPCClient.init(GW_COGRPC_HOST_URL);
  try {
    // Deliver the ping message encapsulated in a cargo
    const cargoSerialized = await encapsulateMessagesInCargo(
      [pingParcelData.parcelSerialized],
      pdaChain,
      publicGatewaySessionKey,
    );
    await asyncIterableToArray(
      cogRPCClient.deliverCargo(
        arrayToAsyncIterable([{ localId: 'random-delivery-id', cargo: cargoSerialized }]),
      ),
    );

    await sleep(IS_GITHUB ? 4 : 2);

    // Collect the pong message encapsulated in a cargo
    const cdaChain = await generateCDAChain(pdaChain);
    const { ccaSerialized, sessionPrivateKey } = await generateCCA(
      GW_INTERNET_ADDRESS,
      publicGatewaySessionKey,
      cdaChain.publicGatewayCert,
      pdaChain.privateGatewayCert,
      pdaChain.privateGatewayPrivateKey,
    );
    const collectedCargoes = await asyncIterableToArray(cogRPCClient.collectCargo(ccaSerialized));
    expect(collectedCargoes).toHaveLength(1);
    const collectedMessages = await extractMessagesFromCargo(
      collectedCargoes[0],
      await pdaChain.privateGatewayCert.calculateSubjectId(),
      sessionPrivateKey,
    );
    expect(collectedMessages).toHaveLength(2);
    expect(ParcelCollectionAck.deserialize(collectedMessages[0])).toHaveProperty(
      'parcelId',
      pingParcelData.parcelId,
    );
    await expect(deserializePong(collectedMessages[1], pingParcelData.sessionKey)).resolves.toEqual(
      pingId,
    );
  } finally {
    cogRPCClient.close();
  }
});
