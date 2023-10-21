import { testDisallowedMethods } from '../../testUtils/fastify';
import { makePoWebTestServer } from './_test_utils';

jest.mock('../../utilities/exitHandling');

describe('healthcheck', () => {
  const getFixtures = makePoWebTestServer();

  testDisallowedMethods(['HEAD', 'GET'], '/', async () => getFixtures().server);

  test('A plain simple HEAD request should provide some diagnostic information', async () => {
    const { server } = getFixtures();

    const response = await server.inject({ method: 'HEAD', url: '/' });

    expect(response).toHaveProperty('statusCode', 200);
    expect(response).toHaveProperty('headers.content-type', 'text/plain');
  });

  test('A plain simple GET request should provide some diagnostic information', async () => {
    const { server } = getFixtures();

    const response = await server.inject({ method: 'GET', url: '/' });

    expect(response).toHaveProperty('statusCode', 200);
    expect(response).toHaveProperty('headers.content-type', 'text/plain');
    expect(response.payload).toContain('Success');
    expect(response.payload).toContain('PoWeb');
  });
});
