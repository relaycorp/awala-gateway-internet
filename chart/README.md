# Helm Chart for the Relaynet-Internet Gateway

This Helm chart allows you to deploy the [Relaynet-Internet Gateway](https://docs.relaycorp.tech/relaynet-internet-gateway/) to any Kubernetes-compatible cloud provider.

There's no Helm repository at this point but you can download the chart directly from a [GitHub release](https://docs.relaycorp.tech/relaynet-internet-gateway-chart/releases). Or if you want to use the latest from the `master` branch, use `https://github.com/relaycorp/relaynet-internet-gateway-chart/archive/master.tar.gz`.

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
helm install \
  --values values.yaml \
  gateway-test \
  https://github.com/relaycorp/relaynet-internet-gateway-chart/archive/master.tar.gz
```

Check out [`example/`](./example) for a working example on Google Cloud Platform.

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

## Development

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
   helm install --values values.dev.yml gw-test .
   ```
