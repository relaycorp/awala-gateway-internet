import VError from 'verror';

export class PublicGatewayError extends VError {
  override get name(): string {
    return this.constructor.name;
  }
}
