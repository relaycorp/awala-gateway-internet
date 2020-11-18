# Relaynet-Internet Gateway

This is the reference implementation of a Relaynet-Internet Gateway, a type of _public gateway_ whose responsibility is to connect private gateways to the Internet. Please refer to the [online documentation](https://docs.relaycorp.tech/relaynet-internet-gateway/) to learn how to operate this app.

# Development

To use this app locally and be able to update the source code, you need the following system dependencies:

- Node.js v12+.
- [Skaffold](https://skaffold.dev/) v1.16+.
- [Helm](https://helm.sh/) v3.4+.

You can then install the Node.js and Helm chart dependencies with:

```
npm install
helm dependency update chart/
```

## Run unit test suite

Run unit tests selectively from your IDE, or run the whole suite with:

```bash
npm test
```

## Run functional test suite

First, run `skaffold delete` to ensure you have a clean fixture and then `skaffold run` to deploy the chart against which you'll run the tests.

Again, you can run the tests selectively from your IDE (using `jest.config.functional.js` as the Jest configuration), or run the whole suite with:

```bash
npm run test:functional
```

When you're done, destroy the environment with `skaffold delete`.

## Run the services locally

Simply run `skaffold dev --port-forward`. The services will then be available at the following addresses:

- PoWeb: `127.0.0.1:8080`
- PoHTTP: `127.0.0.1:8081`
- CogRPC: `127.0.0.1:8082`

## Access to backing services

The backing services that offer web interfaces may be accessed with the following.

- Vault:
  - URL: `http://127.0.0.1:8200`
  - Token: `root`
- Minio:
  - URL: `http://127.0.0.1:9000`
  - Access key: `test-key`
  - Secret key: `test-secret`

## Contributing

We love contributions! If you haven't contributed to a Relaycorp project before, please take a minute to [read our guidelines](https://github.com/relaycorp/.github/blob/master/CONTRIBUTING.md) first.
