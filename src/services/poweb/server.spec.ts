import pino from 'pino';

import { mockSpy } from '../../testUtils/jest';
import * as fastifyUtils from '../../utilities/fastify/server';
import { makePoWebTestServer } from './_test_utils';
import { makeServer } from './server';

jest.mock('../../utilities/exitHandling');

makePoWebTestServer();

const mockFastifyInstance = { close: jest.fn() };
const mockConfigureFastify = mockSpy(
  jest.spyOn(fastifyUtils, 'configureFastify'),
  () => mockFastifyInstance,
);

describe('makeServer', () => {
  test('No logger should be passed by default', async () => {
    await makeServer();

    expect(mockConfigureFastify).toBeCalledWith(expect.anything(), expect.anything(), undefined);
  });

  test('Any explicit logger should be honored', async () => {
    const logger = pino();

    await makeServer(logger);

    expect(mockConfigureFastify).toBeCalledWith(expect.anything(), expect.anything(), logger);
  });

  test('Fastify instance should be returned', async () => {
    await expect(makeServer()).resolves.toEqual(mockFastifyInstance);
  });
});
