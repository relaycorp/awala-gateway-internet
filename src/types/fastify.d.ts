import { Connection } from 'mongoose';

declare module 'fastify' {
  export interface FastifyInstance {
    mongoose: Connection;
  }
}
