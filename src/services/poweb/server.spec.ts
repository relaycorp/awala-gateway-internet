// tslint:disable:no-let

import { mockSpy } from '../../_test_utils';
import * as fastifyUtils from '../fastifyUtils';
import { setUpCommonFixtures } from './_test_utils';
import RouteOptions from './RouteOptions';
import { makeServer } from './server';

const getFixtures = setUpCommonFixtures();

const mockFastifyInstance = {};
const mockConfigureFastify = mockSpy(
  jest.spyOn(fastifyUtils, 'configureFastify'),
  () => mockFastifyInstance,
);

describe('makeServer', () => {
  test('Private key should be loaded and added to the options', async () => {
    await makeServer();

    expect(mockConfigureFastify).toBeCalledWith(
      expect.anything(),
      expect.objectContaining<Partial<RouteOptions>>({
        publicGatewayPrivateKey: getFixtures().publicGatewayPrivateKey,
      }),
      undefined,
    );
  });

  test('Gateway key id should be added to the options', async () => {
    await makeServer();

    expect(mockConfigureFastify).toBeCalledWith(
      expect.anything(),
      expect.objectContaining<Partial<RouteOptions>>({
        publicGatewayCertificate: expect.toSatisfy((c) =>
          c.isEqual(getFixtures().publicGatewayCert),
        ),
      }),
      undefined,
    );
  });

  test('No logger should be passed by default', async () => {
    await makeServer();

    expect(mockConfigureFastify).toBeCalledWith(expect.anything(), expect.anything(), undefined);
  });

  test('Any explicit logger should be honored', async () => {
    const logger: fastifyUtils.FastifyLogger = { level: 'debug' };

    await makeServer(logger);

    expect(mockConfigureFastify).toBeCalledWith(expect.anything(), expect.anything(), logger);
  });

  test('Fastify instance should be returned', async () => {
    await expect(makeServer()).resolves.toEqual(mockFastifyInstance);
  });
});
