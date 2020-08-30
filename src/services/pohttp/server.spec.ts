import { mockSpy } from '../../_test_utils';
import * as fastifyUtils from '../fastifyUtils';
import { makeServer } from './server';

const mockFastifyInstance = {};
const mockConfigureFastify = mockSpy(
  jest.spyOn(fastifyUtils, 'configureFastify'),
  () => mockFastifyInstance,
);

describe('makeServer', () => {
  test('Routes should be loaded', async () => {
    await makeServer();

    expect(mockConfigureFastify).toBeCalledTimes(1);
    expect(mockConfigureFastify).toBeCalledWith([require('./routes').default]);
  });

  test('Fastify instance should be returned', async () => {
    await expect(makeServer()).resolves.toEqual(mockFastifyInstance);
  });
});
