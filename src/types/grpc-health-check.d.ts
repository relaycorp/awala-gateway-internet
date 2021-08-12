declare module 'grpc-health-check' {
  import { ServiceDefinition } from '@grpc/grpc-js';

  export const service: ServiceDefinition<any>;
  export class Implementation {
    constructor(map: { readonly [key: string]: string });
  }

  export const messages: {
    readonly HealthCheckResponse: {
      readonly ServingStatus: {
        readonly NOT_SERVING: any;
        readonly SERVING: any;
      };
    };
  };
}
