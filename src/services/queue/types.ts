import type { FastifyBaseLogger } from 'fastify';
import type { CloudEventV1 } from 'cloudevents';
import type { Connection } from 'mongoose';

import type { InternetGatewayManager } from '../../node/InternetGatewayManager';
import type { QueueEmitter } from '../../utilities/backgroundQueue/QueueEmitter';
import type { ParcelStore } from '../../parcelStore';
import type { RedisPublishFunction } from '../../backingServices/RedisPubSubClient';

export interface MessageSinkHandlerContext {
  readonly dbConnection: Connection;
  readonly logger: FastifyBaseLogger;
  readonly gatewayManager: InternetGatewayManager;
  readonly queueEmitter: QueueEmitter;
  readonly parcelStore: ParcelStore;
  readonly redisPublish: RedisPublishFunction;
}

export type MessageSinkHandler = (
  event: CloudEventV1<Buffer>,
  context: MessageSinkHandlerContext,
) => Promise<boolean>;

export interface MessageSink {
  readonly eventType: string;
  readonly handler: MessageSinkHandler;
}
