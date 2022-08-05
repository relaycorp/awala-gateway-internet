#!/bin/bash
set -o nounset
set -o errexit
set -o pipefail
set -x

# Ugly workaround for https://github.com/GoogleContainerTools/skaffold/issues/4022

kubectl port-forward --address 127.0.0.1 svc/public-gateway-poweb 8080:8082 &
kubectl port-forward --address 127.0.0.1 svc/public-gateway-pohttp 8081:80 &
kubectl port-forward --address 127.0.0.1 svc/public-gateway-cogrpc 8082:8081 &
kubectl port-forward --address 127.0.0.1 svc/pong-pohttp 8083:80 &
kubectl port-forward --address 127.0.0.1 svc/nats 4222:4222 &
kubectl port-forward --address 127.0.0.1 svc/minio 9000:9000 &

# Check at least one of the ports:
timeout 5 sh -c "while ! wget --spider http://127.0.0.1:8080 ; do sleep 1s ; done"
