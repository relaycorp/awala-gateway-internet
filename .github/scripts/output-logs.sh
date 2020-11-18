#!/bin/bash
set -o nounset
set -o errexit
set -o pipefail

if ! command -v kubectl; then
  echo "Skipping because Kubernetes wasn't installed" >&2
  exit 1
fi

DEPLOYMENTS="$(
  kubectl get deploy \
    -l app.kubernetes.io/name=relaynet-internet-gateway \
    "-o=jsonpath={.items[*]['metadata.name']}"
)"

for deployment in ${DEPLOYMENTS}; do
  printf '#%.0s' {1..50}
  echo " Logs for ${deployment}"

  kubectl logs "deploy/${deployment}" --all-containers=true
done
