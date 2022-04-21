import { status } from '@grpc/grpc-js';

export const INTERNAL_SERVER_ERROR = {
  code: status.UNAVAILABLE,
  message: 'Internal server error; please try again later',
};
