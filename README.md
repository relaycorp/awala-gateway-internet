# Relaynet-Internet Gateway

This is the reference implementation of a Relaynet-Internet Gateway, a type of _public gateway_ whose responsibility is to connect private gateways to the Internet. Please refer to the [online documentation](https://docs.relaycorp.tech/relaynet-internet-gateway/) to learn how to operate this app.

# Development

To use this app locally and be able to update the source code, you need the following system dependencies:

- Node.js v12+.
- Docker and Docker Compose, if you want to run the Docker image or its functional test suite.

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

## Run the servers with Docker Compose

With the Docker Compose project running in the background (e.g., `docker-compose up --build --remove-orphans --abort-on-container-exit -d`), run the following commands to bootstrap the backing services.

Create the Vault backend and the initial key pair:

```
docker-compose exec -e VAULT_ADDR='http://127.0.0.1:8200' -e VAULT_TOKEN=letmein vault vault secrets enable -path=gw-keys kv-v2
docker-compose run --rm cogrpc src/bin/generate-keypairs.ts
```

Create the Minio bucket:

```
MC_HOST_minio=http://THE-KEY-ID:letmeinpls@object-store:9000
docker run --rm --network=relaynet-internet-gateway_default -e MC_HOST_minio minio/mc mb minio/relaynet-public-gateway
```

## Using the Helm chart

Here's how to set up your local environment for development:

1. Install Vault and enable the KV secret store:
   ```
   # Add HashiCorp's repo if you haven't done so yet
   helm repo add hashicorp https://helm.releases.hashicorp.com
   
   helm install vault-test hashicorp/vault \
       --set "server.dev.enabled=true" \
       --set "server.image.extraEnvironmentVars.VAULT_DEV_ROOT_TOKEN_ID=letmein"
   
   kubectl exec -it vault-test-0 -- vault secrets enable -path=gw-keys kv-v2
   ```
1. Install NATS Streaming: https://github.com/nats-io/nats-streaming-operator
1. Install Mongo:
   ```
   helm repo add bitnami https://charts.bitnami.com/bitnami
   helm install mongo-test bitnami/mongodb
   ```
1. Install Minio:
   ```
   helm install \
       --set accessKey=THE-KEY-ID,secretKey=letmeinpls \
       minio-test \
       stable/minio
   ```
1. Install gw:
   ```
   helm install --values chart/values.dev.yml gw-test chart/
   ```

## Contributing

We love contributions! If you haven't contributed to a Relaycorp project before, please take a minute to [read our guidelines](https://github.com/relaycorp/.github/blob/master/CONTRIBUTING.md) first.
