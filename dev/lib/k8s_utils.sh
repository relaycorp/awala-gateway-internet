get_random_pod_from_app() {
  local app_name="$1"
  kubectl get pod \
    -l "app.kubernetes.io/name=${app_name}" \
    --no-headers \
    --output=jsonpath='{.items[0].metadata.name}'
}
