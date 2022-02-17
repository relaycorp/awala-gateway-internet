import * as grpc from '@grpc/grpc-js';

export const INTERNAL_SERVER_ERROR = {
  code: grpc.status.UNAVAILABLE,
  message: 'Internal server error; please try again later',
};
