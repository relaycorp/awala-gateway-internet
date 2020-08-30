// tslint:disable:no-let

import { MockPrivateKeyStore } from '@relaycorp/relaynet-core';

import { mockSpy } from '../../_test_utils';
import * as privateKeyStore from '../../backingServices/privateKeyStore';
import { configureMockEnvVars } from '../_test_utils';
import * as fastifyUtils from '../fastifyUtils';
import RouteOptions from './RouteOptions';
import { makeServer } from './server';

const GATEWAY_KEY_ID = 'MTM1NzkK';
configureMockEnvVars({ GATEWAY_KEY_ID });

const mockFastifyInstance = {};
const mockConfigureFastify = mockSpy(
  jest.spyOn(fastifyUtils, 'configureFastify'),
  () => mockFastifyInstance,
);

let mockPrivateKeyStore: MockPrivateKeyStore;
beforeEach(async () => {
  mockPrivateKeyStore = new MockPrivateKeyStore();
});
mockSpy(jest.spyOn(privateKeyStore, 'initVaultKeyStore'), () => mockPrivateKeyStore);

describe('makeServer', () => {
  test('Routes should be loaded', async () => {
    await makeServer();

    expect(mockConfigureFastify).toBeCalledTimes(1);
    expect(mockConfigureFastify).toBeCalledWith(
      [require('./preRegistration').default],
      expect.anything(),
    );
  });

  test('Private key store should be loaded and added to the options', async () => {
    await makeServer();

    expect(mockConfigureFastify).toBeCalledWith(
      expect.anything(),
      expect.objectContaining<Partial<RouteOptions>>({
        privateKeyStore: mockPrivateKeyStore,
      }),
    );
  });

  test('Gateway key id should be added to the options', async () => {
    await makeServer();

    expect(mockConfigureFastify).toBeCalledWith(
      expect.anything(),
      expect.objectContaining<Partial<RouteOptions>>({
        gatewayKeyId: Buffer.from(GATEWAY_KEY_ID, 'base64'),
      }),
    );
  });

  test('Fastify instance should be returned', async () => {
    await expect(makeServer()).resolves.toEqual(mockFastifyInstance);
  });
});
