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
  test('Routes should be loaded', async () => {
    await makeServer();

    expect(mockConfigureFastify).toBeCalledTimes(1);
    expect(mockConfigureFastify).toBeCalledWith(
      [require('./preRegistration').default],
      expect.anything(),
    );
  });

  test('Private key should be loaded and added to the options', async () => {
    await makeServer();

    expect(mockConfigureFastify).toBeCalledWith(
      expect.anything(),
      expect.objectContaining<Partial<RouteOptions>>({
        publicGatewayPrivateKey: getFixtures().publicGatewayPrivateKey,
      }),
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
    );
  });

  test('Fastify instance should be returned', async () => {
    await expect(makeServer()).resolves.toEqual(mockFastifyInstance);
  });
});
