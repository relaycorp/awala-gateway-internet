import { testDisallowedMethods } from '../_test_utils';
import { setUpCommonFixtures } from './_test_utils';
import { makeServer } from './server';

const ENDPOINT_URL = '/v1/parcels';

setUpCommonFixtures();

describe('Disallowed methods', () => {
  testDisallowedMethods(['POST'], ENDPOINT_URL, makeServer);
});
