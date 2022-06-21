#!/bin/bash
set -o nounset
set -o errexit
set -o pipefail

HELM_PACKAGE="$(find build/ -name 'relaynet-internet-gateway-*.tgz' | head -n1)"
export HELM_EXPERIMENTAL_OCI=1
helm cm-push "${HELM_PACKAGE}" https://h.cfcr.io/relaycorp/public
