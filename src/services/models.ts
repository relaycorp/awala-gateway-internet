/* tslint:disable:readonly-keyword max-classes-per-file */

import { index, prop } from '@typegoose/typegoose';

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

@index({ peerPrivateAddress: 1, ccaId: 1 }, { unique: true })
export class CCAFulfillment {
  @prop({ required: true })
  public peerPrivateAddress!: string;

  @prop({ required: true })
  public ccaId!: string;

  @prop({ required: true, expires: 0 })
  public ccaExpiryDate!: Date;
}
