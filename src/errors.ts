import VError from 'verror';

export class InternetGatewayError extends VError {
  override get name(): string {
    return this.constructor.name;
  }
}
