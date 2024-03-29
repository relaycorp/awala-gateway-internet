---
nav_order: 10
permalink: /install
---
# Install and upgrade

The Awala-Internet Gateway is distributed as a Helm chart. Note that deploying the Docker images directly is discouraged: We're likely to change paths, as well as split and rename the Docker image.

## Example

At a minimum, you have to specify the Internet address and the connection settings for the backing services; e.g.:

```yaml
# values.yaml
internetAddress: eu.relaycorp.tech
mongo:
  uri: mongodb+srv://foo.gcp.mongodb.net
  db: db
  user: the_user
  password: passw0rd
redis:
  url: redis://redis.example.com:6379
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
  relaycorp/awala-gateway-internet
```

Check out [`relaycorp/cloud-gateway`](https://github.com/relaycorp/cloud-gateway) for a working example on Google Cloud Platform.

## Global options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `nameOverride` | string | | A custom name for the release, to override the one passed to Helm |
| `image.repository` | string | `ghcr.io/relaycorp/awala-gateway-internet` | Docker image for the gateway |
| `image.tag` | string | (Same as the chart version) | Docker image tag |
| `podSecurityContext` | object | `{}` | A custom `securityContext` to be attached to the pods |
| `podAnnotations` | object | `{}` | Annotations to be attached to the pods |
| `serviceAccountAnnotations` | object | `{}` | Annotations to be attached to the service account |
| `securityContext` | object | `{}` | A custom `securityContext` to be attached to the deployments |
| `service.type` | string | `ClusterIP` | The service type for the PoWeb, PoHTTP and CogRPC servers |
| `internetAddress` | string | | The Internet address of this gateway |
| `ingress.enabled` | boolean | `false` | Whether to use an ingress for the PoWeb, PoHTTP and CogRPC servers |
| `ingress.annotations` | object | `{}` | Annotations for the ingress |
| `ingress.enableTls` | boolean | `true` | Whether the ingress should use TLS. You still have to configure TLS through your cloud provider; see [GKE documentation](https://cloud.google.com/kubernetes-engine/docs/concepts/ingress), for example. |
| `objectStore.backend` | string | | The type of object store used. Any value supported by [`@relaycorp/object-storage`](https://github.com/relaycorp/object-storage-js) (e.g., `s3`). |
| `logging.level` | string | `info` | The [log level](instrumentation.md). |
| `logging.target` | string | | Any target supported by [@relaycorp/pino-cloud](https://www.npmjs.com/package/@relaycorp/pino-cloud); e.g., `gcp`. |
| `logging.envName` | string | `awala-gateway-internet` | A unique name for this instance of the gateway. Used by the `gcp` target as the _service name_ when pushing errors to Google Error Reporting, for example. |

### Component-specific options

Each gateway component has the following options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `ingress.serviceDomains.cogrpc` | string | `cogrpc.${internetAddress}` | Domain name for the CogRPC service |
| `cogrpc.serviceAnnotations` | object | `{}` | Service annotations for the CogRPC service |
| `cogrpc.replicas` | number | `1` | Number of servers in CogRPC service |
| `cogrpc.resources` | object | `{}` | Container resources for the gRPC server in the CogRPC service |
| `cogrpc.affinity` | object | | Affinity settings for CogRPC |
| `ingress.serviceDomains.pohttp` | string | `pohttp.${internetAddress}` | Domain name for the PoHTTP service |
| `pohttp.replicas` | number | `1` | Number of servers in the PoHTTP service |
| `pohttp.resources` | object | `{}` | Container resources for the HTTP server in the PoHTTP service |
| `pohttp.affinity` | object | | Affinity settings for PoHTTP |
| `ingress.serviceDomains.poweb` | string | `poweb.${internetAddress}` | Domain name for the PoWeb service |
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
| `redis.url` | string | | Connection URI for Redis |
| `objectStore.endpoint` | string | | Host name and port number for the object store server |
| `objectStore.bucket` | string | | Bucket name |
| `objectStore.accessKeyId` | string | | Access key id to the object store |
| `objectStore.secretKey` | string | | Secret key to the object store |
| `objectStore.tlsEnabled` | boolean | `true` | Whether TLS is enabled and required |

#### Key store

When using the GCP adapter (`keystore.adapter=gcp`):

| Option | Type | Default | Description |
| --- | --- | --- |  --- |
| `keystore.location` | string | | GCP location (e.g., `europe-west3`) |
| `keystore.kmsKeyring` | string | | The KMS keyring holding all the keys to be used |
| `keystore.kmsIdKey` | string | | The name of the KMS key whose versions will back Awala identity keys |
| `keystore.kmsSessionEncryptionKey` | string | | The name of the KMS key used to encrypt Awala session keys |

When using the Vault adapter (`keystore.adapter=vault`):

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `keystore.serverUrl` | string | | URL to the HashiCorp Vault server |
| `keystore.token` | string | | Token to the HashiCorp Vault server |
| `keystore.kvPrefix` | string | `gw-keys` | The path prefix for the Vault secret engine |
