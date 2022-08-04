import { CogRPCClient } from '@relaycorp/cogrpc';
import { Parcel, ParcelCollectionAck, ParcelDeliverySigner } from '@relaycorp/relaynet-core';
import { PoWebClient } from '@relaycorp/relaynet-poweb';
import uuid from 'uuid-random';

import { arrayToAsyncIterable, asyncIterableToArray } from '../testUtils/iter';
import { generateCCA, generateCDAChain } from '../testUtils/pki';
import { encapsulateMessagesInCargo, extractMessagesFromCargo } from './utils/cargo';
import {
  GW_COGRPC_HOST,
  GW_INTERNET_ADDRESS,
  GW_POWEB_HOST_PORT,
  IS_GITHUB,
} from './utils/constants';
import { createAndRegisterPrivateGateway } from './utils/gatewayRegistration';
import { extractPong, makePingParcel } from './utils/ping';
import { collectNextParcel } from './utils/poweb';
import { sleep } from './utils/timing';

test('Sending pings via PoWeb and receiving pongs via PoHTTP', async () => {
  const powebClient = PoWebClient.initLocal(GW_POWEB_HOST_PORT);
  const { pdaChain } = await createAndRegisterPrivateGateway();

  const pingId = uuid();
  const { parcelSerialized: pingParcelSerialized, sessionKey } = await makePingParcel(
    pingId,
    pdaChain,
  );

  // Deliver the ping message
  await powebClient.deliverParcel(
    pingParcelSerialized,
    new ParcelDeliverySigner(pdaChain.privateGatewayCert, pdaChain.privateGatewayPrivateKey),
  );

  // Collect the pong message once it's been received
  const pongParcel = await collectNextParcel(
    powebClient,
    pdaChain.privateGatewayCert,
    pdaChain.privateGatewayPrivateKey,
  );
  await expect(extractPong(pongParcel, sessionKey)).resolves.toEqual(pingId);
});

test('Sending pings via CogRPC and receiving pongs via PoHTTP', async () => {
  const { pdaChain, publicGatewaySessionKey } = await createAndRegisterPrivateGateway();

  const pingId = uuid();
  const pingParcelData = await makePingParcel(pingId, pdaChain);

  const cogRPCClient = await CogRPCClient.initInternet(GW_COGRPC_HOST);
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
      pdaChain.privateGatewayCert,
      sessionPrivateKey,
    );
    expect(collectedMessages).toHaveLength(2);
    const collectionAck = collectedMessages[0];
    expect(collectionAck).toBeInstanceOf(ParcelCollectionAck);
    expect(collectionAck).toHaveProperty('parcelId', pingParcelData.parcelId);
    const pongParcel = collectedMessages[1];
    expect(pongParcel).toBeInstanceOf(Parcel);
    await expect(extractPong(pongParcel as Parcel, pingParcelData.sessionKey)).resolves.toEqual(
      pingId,
    );
  } finally {
    cogRPCClient.close();
  }
});
