import type { FastifyInstance } from 'fastify';
import type { BaseLogger } from 'pino';

export type ServerMaker = (logger?: BaseLogger) => Promise<FastifyInstance>;
