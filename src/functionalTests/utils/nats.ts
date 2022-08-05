import { get as getEnvVar } from 'env-var';
import { connect as stanConnect, Stan } from 'node-nats-streaming';
import uuid from 'uuid-random';

export function connectToNatsStreaming(): Promise<Stan> {
  return new Promise((resolve) => {
    const stanConnection = stanConnect(
      getEnvVar('NATS_CLUSTER_ID').required().asString(),
      `functional-tests-${uuid()}`,
      {
        url: getEnvVar('NATS_SERVER_URL').required().asString(),
      },
    );
    stanConnection.on('connect', resolve);
  });
}
