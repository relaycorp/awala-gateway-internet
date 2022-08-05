import { InternetGatewayError } from './errors';

test('.name should be taken from the name of the class', () => {
  class FooError extends InternetGatewayError {}
  const error = new FooError('Winter is coming');
  expect(error.name).toBe('FooError');
});
