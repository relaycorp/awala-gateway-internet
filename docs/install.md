---
nav_order: 10
permalink: /install
---
# Install and upgrade

The Relaynet-Internet Gateway is distributed as a Helm chart. Note that deploying the Docker images directly is discouraged: We're likely to change paths, as well as split and rename the Docker image.

## Example

At a minimum, you have to specify the domain names for the services and the connection settings for the backing services; e.g.:

```yaml
# values.yaml
cogrpcHost: gogrpc.eu.relaycorp.tech
pohttpHost: pohttp.eu.relaycorp.tech
powebHost: poweb.eu.relaycorp.tech
mongo:
  uri: mongodb+srv://user:password@foo.gcp.mongodb.net/db
nats:
  serverUrl: nats://nats.example.com:4222
  clusterId: example-stan
objectStore:
  endpoint: minio.example.com:9000
  bucket: public-gateway
  accessKeyId: test-key
  secretKey: test-secret
vault:
  serverUrl: https://vault.example.com
  token: the-secret-token
```

Then you can install the chart:

```
helm repo add relaycorp https://h.cfcr.io/relaycorp/public

helm install \
  --values values.yaml \
  gateway-test \
  relaycorp/relaynet-internet-gateway
```

Check out [`relaycorp/cloud-gateway`](https://github.com/relaycorp/cloud-gateway) for a working example on Google Cloud Platform.

## Configuration options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `nameOverride` | string | | A custom name for the release, to override the one passed to Helm |
| `podSecurityContext` | object | `{}` | A custom `securityContext` to be attached to the pods |
| `securityContext` | object | `{}` | A custom `securityContext` to be attached to the deployments |
| `resources` | object | `{}` | A custom name `resources` to be attached to the containers |
| `service.type` | string | `ClusterIP` | The service type for the PoHTTP endpoint |
| `service.port` | number | `80` | The service port for the PoHTTP endpoint |
| `ingress.enabled` | boolean | `false` | Whether to use an ingress for the PoHTTP endpoint |
| `ingress.annotations` | object | `{}` | Annotations for the ingress |
| `cogrpcHost` | string | | Domain name for the CogRPC service |
| `pohttpHost` | string | | Domain name for the PoHTTP service |
| `powebHost` | string | | Domain name for the PoWeb service |
| `pdcQueue.replicaCount` | number | 3 | Number of workers (pods) for the PDC queue |
| `mongo.uri` | string | | Connection URI for MongoDB |
| `nats.serverUrl` | string | | Connection URI for NATS Streaming |
| `nats.clusterId` | string | | NATS Streaming cluster id |
| `objectStore.endpoint` | string | | Host name and port number for the object store server |
| `objectStore.bucket` | string | | Bucket name |
| `objectStore.accessKeyId` | string | | Access key id to the object store |
| `objectStore.secretKey` | string | | Secret key to the object store |
| `objectStore.tlsEnabled` | boolean | `true` | Whether TLS is enabled and required |
| `vault.serverUrl` | string | | URL to the HashiCorp Vault server |
| `vault.token` | string | | Token to the HashiCorp Vault server |
| `vault.kvPrefix` | string | `gw-keys` | The path prefix for the Vault secret engine |
