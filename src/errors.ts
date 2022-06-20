import VError from 'verror';

export class PublicGatewayError extends VError {
  get name(): string {
    return this.constructor.name;
  }
}
