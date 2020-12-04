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
  uri: mongodb+srv://foo.gcp.mongodb.net
  db: db
  user: the_user
  password: passw0rd
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

## Global options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `nameOverride` | string | | A custom name for the release, to override the one passed to Helm |
| `image.repository` | string | `ghcr.io/relaycorp/relaynet-internet-gateway` | Docker image for the gateway |
| `image.tag` | string | (Same as the chart version) | Docker image tag |
| `podSecurityContext` | object | `{}` | A custom `securityContext` to be attached to the pods |
| `securityContext` | object | `{}` | A custom `securityContext` to be attached to the deployments |
| `service.type` | string | `ClusterIP` | The service type for the PoWeb, PoHTTP and CogRPC servers |
| `ingress.enabled` | boolean | `false` | Whether to use an ingress for the PoWeb, PoHTTP and CogRPC servers |
| `ingress.annotations` | object | `{}` | Annotations for the ingress |

### Component-specific options

Each gateway component has the following options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `cogrpcHost` | string | | Domain name for the CogRPC service |
| `cogrpc.serviceAnnotations` | object | `{}` | Service annotations for the CogRPC service |
| `cogrpc.replicas` | number | `1` | Number of servers in CogRPC service |
| `cogrpc.resources` | object | `{}` | Container resources for the gRPC server in the CogRPC service |
| `cogrpc.affinity` | object | | Affinity settings for CogRPC |
| `pohttpHost` | string | | Domain name for the PoHTTP service |
| `pohttp.replicas` | number | `1` | Number of servers in the PoHTTP service |
| `pohttp.resources` | object | `{}` | Container resources for the HTTP server in the PoHTTP service |
| `pohttp.affinity` | object | | Affinity settings for PoHTTP |
| `powebHost` | string | | Domain name for the PoWeb service |
| `poweb.replicas` | number | `1` | Number of servers in the PoWeb service |
| `poweb.resources` | object | `{}` | Container resources for the HTTP server in the PoWeb service |
| `poweb.affinity` | object | | Affinity settings for PoWeb |
| `pdcQueue.replicas` | number | `1` | Number of workers (pods) for the PDC queue |
| `pdcQueue.resources` | object | `{}` | Container resources for the PDC queue |
| `pdcQueue.affinity` | object | | Affinity settings for the PDC queue |
| `crcQueue.replicas` | number | `1` | Number of workers (pods) for the CRC queue |
| `crcQueue.resources` | object | `{}` | Container resources for the CRC queue |
| `crcQueue.affinity` | object | | Affinity settings for the CRC queue |

### Backing services

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mongo.uri` | string | | Connection URI for MongoDB |
| `mongo.db` | string | | MongoDB database name |
| `mongo.user` | string | | MongoDB user name |
| `mongo.password` | string | | MongoDB user password |
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
