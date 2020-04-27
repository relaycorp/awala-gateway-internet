/* tslint:disable:readonly-keyword max-classes-per-file */

import { prop } from '@typegoose/typegoose';

const SECONDS_IN_A_DAY = 86400;

export class OwnCertificate {
  @prop({ required: true })
  public serializationDer!: Buffer;
}

export class PeerPublicKeyData {
  protected static TTL_DAYS = 30;

  @prop({ required: true, unique: true })
  public peerPrivateAddress!: string;

  @prop({ required: true })
  public keyId!: Buffer;

  @prop({ required: true })
  public keyDer!: Buffer;

  @prop({ required: true, expires: PeerPublicKeyData.TTL_DAYS * SECONDS_IN_A_DAY })
  public creationDate!: Date;
}
