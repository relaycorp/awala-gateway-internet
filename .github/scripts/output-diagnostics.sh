#!/bin/bash
set -o nounset
set -o errexit
set -o pipefail

# Functions

print_header() {
  local title="$1"

  printf '#%.0s' {1..50}
  echo " ${title}"
}

# Main

if ! command -v kubectl; then
  echo "Skipping because Kubernetes wasn't installed" >&2
  exit 1
fi

print_header "Services"
kubectl get services

print_header "Jobs"
kubectl get jobs

print_header "Pods"
kubectl get pods

PODS="$(
  kubectl get pod \
    -l app.kubernetes.io/name=relaynet-internet-gateway \
    "-o=jsonpath={.items[*]['metadata.name']}"
)"

for pod in ${PODS}; do
  print_header "Logs for ${pod}"

  kubectl logs "${pod}" --all-containers=true
done
