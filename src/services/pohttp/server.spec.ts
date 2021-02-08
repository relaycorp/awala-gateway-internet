import { mockSpy } from '../../_test_utils';
import * as fastifyUtils from '../fastify';
import { makeServer } from './server';

jest.mock('../../utilities/exitHandling');

const mockFastifyInstance = {};
const mockConfigureFastify = mockSpy(
  jest.spyOn(fastifyUtils, 'configureFastify'),
  () => mockFastifyInstance,
);

describe('makeServer', () => {
  test('Routes should be loaded', async () => {
    await makeServer();

    expect(mockConfigureFastify).toBeCalledWith([require('./routes').default]);
  });

  test('Fastify instance should be returned', async () => {
    await expect(makeServer()).resolves.toEqual(mockFastifyInstance);
  });
});
