load('./dev/lib/tilt_utils.bzl', 'bash_exec')

docker_build('public-gateway', '.', dockerfile='Dockerfile')

watch_file('helmfile.yaml')
watch_file('chart/values.dev.yml')
k8s_yaml(local('helmfile -f helmfile.yaml template'))

k8s_resource(
  'stan',
  resource_deps=['nats'],
)

k8s_resource(
  'vault',
  port_forwards=['127.0.0.1:8200:8200'],
)
local_resource(
  'vault-config',
  cmd=bash_exec('vault-config.sh', 'gw-keys'),
  resource_deps=['vault'],
)

k8s_resource(
  'minio',
  port_forwards=['127.0.0.1:9000:9000'],
)

# Gateway resources
gw_dependencies = ['minio', 'mongodb', 'stan', 'vault-config']

k8s_resource(
  'gateway-relaynet-internet-gateway-poweb',
  new_name='gw-poweb',
  port_forwards=['127.0.0.1:8080:8080'],
  resource_deps=gw_dependencies,
)
k8s_resource(
  'gateway-relaynet-internet-gateway-pohttp',
  new_name='gw-pohttp',
  port_forwards=['127.0.0.1:8081:8080'],
  resource_deps=gw_dependencies,
)
k8s_resource(
  'gateway-relaynet-internet-gateway-cogrpc',
  new_name='gw-cogrpc',
  port_forwards=['127.0.0.1:8082:8080', '127.0.0.1:8083:8081'],
  resource_deps=gw_dependencies,
)
k8s_resource(
  'gateway-relaynet-internet-gateway-crcin',
  new_name='gw-crc-in',
  resource_deps=gw_dependencies,
)
k8s_resource(
  'gateway-relaynet-internet-gateway-pdcout',
  new_name='gw-pdc-out',
  resource_deps=gw_dependencies,
)
k8s_resource(
  'gateway-relaynet-internet-gateway-test-services',
  new_name='gw-test',
  resource_deps=['gw-pohttp', 'gw-poweb', 'gw-cogrpc'],
)
