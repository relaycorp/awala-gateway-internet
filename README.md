# Relaynet-Internet Gateway

This is the reference implementation of a Relaynet-Internet Gateway, a type of _public gateway_ whose responsibility is to connect private gateways to the Internet. Please refer to the [online documentation](https://docs.relaycorp.tech/relaynet-internet-gateway/) to learn how to operate this app.

# Development

To use this app locally and be able to update the source code, you need the following system dependencies:

- Node.js v12+.
- [Tilt](https://docs.tilt.dev/install.html).
- [helmfile](https://github.com/roboll/helmfile).

The dependencies can be installed with the usual `npm install`.

## Run unit test suite

Run unit tests selectively from your IDE, or run the whole suite with:

```bash
npm test
```

## Run functional test suite

Again, you can run the tests selectively from your IDE (using `jest.config.functional.js` as the Jest configuration), or run the whole suite with:

```bash
npm run test:functional
```

## Run the services with Tilt

Simple use [use Tilt](https://docs.tilt.dev/welcome_to_tilt.html) in this directory.

## Access to backing services

The Tilt dashboard contains shortcuts to the UI of the backing services, where applicable. Use the follow credentials when prompted:

- Vault:
  - Token: `root`
- Minio:
  - Access key: `test-key`
  - Secret key: `test-secret`

## Contributing

We love contributions! If you haven't contributed to a Relaycorp project before, please take a minute to [read our guidelines](https://github.com/relaycorp/.github/blob/master/CONTRIBUTING.md) first.
