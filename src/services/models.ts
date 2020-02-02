/* tslint:disable:readonly-keyword */

import { prop } from '@typegoose/typegoose';

export class OwnCertificate {
  @prop()
  public serializationDer!: Buffer;
}
