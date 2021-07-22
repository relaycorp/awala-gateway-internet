import { PublicGatewayError } from './errors';

test('.name should be taken from the name of the class', () => {
  class FooError extends PublicGatewayError {}
  const error = new FooError('Winter is coming');
  expect(error.name).toBe('FooError');
});
