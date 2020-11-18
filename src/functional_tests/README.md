# Functional test suite

As functional tests, the tests in this directory must adhere to the following constraints:

- Mocks or spies can't be used -- at least not on the code under test.
- The code under test must not be imported: If we need to use it, it must be run as a separate process.
- The executed code must not count towards the unit test coverage.

## Fixture isolation

In order to give each test its own isolated fixture, a new private gateway should be registered on each test.
