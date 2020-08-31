// tslint:disable:no-let

import { MockPrivateKeyStore } from '@relaycorp/relaynet-core';
import { FastifyInstance } from 'fastify';
import fastifyPlugin from 'fastify-plugin';

import { mockSpy, PdaChain } from '../../_test_utils';
import * as privateKeyStore from '../../backingServices/privateKeyStore';
import { configureMockEnvVars, generatePdaChain } from '../_test_utils';

const BASE_ENV_VARS = { MONGO_URI: 'mongodb://example.com' };

export interface FixtureSet extends PdaChain {}

export function setUpCommonFixtures(): () => FixtureSet {
  //region fastify-mongoose
  const mockFastifyPlugin = fastifyPlugin;
  jest.mock('fastify-mongoose', () => {
    function mockFunc(_fastify: FastifyInstance, _options: any, next: () => void): void {
      next();
    }
    return mockFastifyPlugin(mockFunc, { name: 'fastify-mongoose' });
  });
  //endregion

  let certificatePath: PdaChain;
  beforeAll(async () => {
    certificatePath = await generatePdaChain();
  });

  let mockPrivateKeyStore: MockPrivateKeyStore;
  beforeEach(async () => {
    mockPrivateKeyStore = new MockPrivateKeyStore();
    await mockPrivateKeyStore.registerNodeKey(
      certificatePath.publicGatewayPrivateKey,
      certificatePath.publicGatewayCert,
    );
  });
  mockSpy(jest.spyOn(privateKeyStore, 'initVaultKeyStore'), () => mockPrivateKeyStore);

  const mockEnvVars = configureMockEnvVars(BASE_ENV_VARS);
  beforeEach(() => {
    const gatewayCertificate = certificatePath.publicGatewayCert;
    mockEnvVars({
      ...BASE_ENV_VARS,
      GATEWAY_KEY_ID: gatewayCertificate.getSerialNumber().toString('base64'),
    });
  });

  return () => ({
    ...certificatePath,
  });
}
