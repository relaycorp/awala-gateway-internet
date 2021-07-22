import VError from 'verror';

export abstract class PublicGatewayError extends VError {
  get name(): string {
    return this.constructor.name;
  }
}
