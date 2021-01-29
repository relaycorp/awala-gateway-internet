import { mockSpy } from '../../_test_utils';
import * as fastifyUtils from '../../utilities/fastify';
import { makeServer } from './server';

const mockFastifyInstance = {};
const mockConfigureFastify = mockSpy(
  jest.spyOn(fastifyUtils, 'configureFastify'),
  () => mockFastifyInstance,
);

describe('makeServer', () => {
  test('Service name should be passed to fastify configuration', async () => {
    await makeServer();

    expect(mockConfigureFastify).toBeCalledWith('pohttp', expect.anything());
  });

  test('Routes should be loaded', async () => {
    await makeServer();

    expect(mockConfigureFastify).toBeCalledWith(expect.anything(), [require('./routes').default]);
  });

  test('Fastify instance should be returned', async () => {
    await expect(makeServer()).resolves.toEqual(mockFastifyInstance);
  });
});
