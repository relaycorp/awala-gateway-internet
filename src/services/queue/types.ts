import type { FastifyBaseLogger } from 'fastify';
import type { CloudEventV1 } from 'cloudevents';

export interface MessageSinkHandlerContext {
  readonly logger: FastifyBaseLogger;
}

export type MessageSinkHandler = (
  event: CloudEventV1<Buffer>,
  context: MessageSinkHandlerContext,
) => Promise<boolean>;

export interface MessageSink {
  readonly eventType: string;
  readonly handler: MessageSinkHandler;
}
