declare module 'grpc-js-health-check' {
  import { ServiceDefinition } from '@grpc/grpc-js';

  export const service: ServiceDefinition<any>;
  export class Implementation {
    constructor(map: { readonly [key: string]: string });
  }

  export const servingStatus: {
    readonly NOT_SERVING: any;
    readonly SERVING: any;
  };
}
