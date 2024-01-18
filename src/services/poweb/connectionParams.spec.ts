import { NodeConnectionParams } from '@relaycorp/relaynet-core';

import { testDisallowedMethods } from '../../testUtils/fastify';
import { makePoWebTestServer } from './_test_utils';
import { CONTENT_TYPES } from './contentTypes';
import { InternetGatewayManager } from '../../node/InternetGatewayManager';
import { GATEWAY_INTERNET_ADDRESS } from '../../testUtils/awala';

jest.mock('../../utilities/exitHandling');

const ENDPOINT_URL = '/connection-params.der';

describe('connectionParams', () => {
  const getFixtures = makePoWebTestServer();

  testDisallowedMethods(['HEAD', 'GET'], ENDPOINT_URL, async () => getFixtures().server);

  test('Should respond with connection parameters', async () => {
    const { server, dbConnection } = getFixtures();
    const gatewayManager = await InternetGatewayManager.init(dbConnection);
    const gateway = await gatewayManager.getCurrent();
    await gateway.makeInitialSessionKeyIfMissing();

    const response = await server.inject({ method: 'GET', url: ENDPOINT_URL });

    expect(response).toHaveProperty('statusCode', 200);
    expect(response).toHaveProperty('headers.content-type', CONTENT_TYPES.CONNECTION_PARAMS);
    const expectedParameters = new NodeConnectionParams(
      GATEWAY_INTERNET_ADDRESS,
      gateway.identityKeyPair.publicKey,
      (await gateway.keyStores.privateKeyStore.retrieveUnboundSessionPublicKey(gateway.id))!,
    );
    expect(response.rawPayload).toMatchObject(Buffer.from(await expectedParameters.serialize()));
  });
});
