import { testDisallowedMethods } from '../_test_utils';
import { setUpCommonFixtures } from './_test_utils';
import { makeServer } from './server';

describe('healthcheck', () => {
  setUpCommonFixtures();

  testDisallowedMethods(['HEAD', 'GET'], '/', makeServer);

  test('A plain simple HEAD request should provide some diagnostic information', async () => {
    const serverInstance = await makeServer();

    const response = await serverInstance.inject({ method: 'HEAD', url: '/' });

    expect(response).toHaveProperty('statusCode', 200);
    expect(response).toHaveProperty('headers.content-type', 'text/plain');
  });

  test('A plain simple GET request should provide some diagnostic information', async () => {
    const serverInstance = await makeServer();

    const response = await serverInstance.inject({ method: 'GET', url: '/' });

    expect(response).toHaveProperty('statusCode', 200);
    expect(response).toHaveProperty('headers.content-type', 'text/plain');
    expect(response.payload).toContain('Success');
    expect(response.payload).toContain('PoWeb');
  });
});
