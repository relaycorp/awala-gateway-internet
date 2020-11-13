. "dev/lib/k8s_utils.sh"

# Functions

wait_for_vault_unseal() {
  local pod_name="$1"
  kubectl exec --request-timeout 10s "${pod_name}" -- \
    sh -c "while ! vault status >>dev/null; do sleep 1; done"
}

is_engine_enabled() {
  local kv_prefix="$1"
  local pod_name="$2"
  kubectl exec "${pod_name}" -- vault secrets list | grep -E "^${kv_prefix}/" --quiet
}

enable_kv_engine() {
  local kv_prefix="$1"
  local pod_name="$2"
  kubectl exec "${pod_name}" -- vault secrets enable -path="${kv_prefix}" kv-v2
}

# Main

SECRETS_PATH_PREFIX="$1"

VAULT_POD="$(get_random_pod_from_app vault)"
wait_for_vault_unseal "${VAULT_POD}"
if ! is_engine_enabled "${SECRETS_PATH_PREFIX}" "${VAULT_POD}"; then
  enable_kv_engine "${SECRETS_PATH_PREFIX}" "${VAULT_POD}"
fi
