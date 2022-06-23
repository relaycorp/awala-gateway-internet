/* tslint:disable:readonly-keyword max-classes-per-file */

import typegoose from '@typegoose/typegoose';

const SECONDS_IN_A_DAY = 86400;

export class ConfigItem {
  @typegoose.prop({ required: true, unique: true })
  public key!: string;

  @typegoose.prop({ required: true })
  public value!: string;
}

@typegoose.index({ subjectPrivateAddress: 1 })
export class CertificationPath {
  @typegoose.prop({ required: true })
  public subjectPrivateAddress!: string;

  @typegoose.prop({ required: true })
  public issuerPrivateAddress!: string;

  @typegoose.prop({ required: true })
  public pathSerialized!: Buffer;

  @typegoose.prop({ required: true, expires: 0 })
  public expiryDate!: Date;
}

export class PeerPublicKeyData {
  protected static TTL_DAYS = 30;

  @typegoose.prop({ required: true, unique: true })
  public peerPrivateAddress!: string;

  @typegoose.prop({ required: true })
  public keyId!: Buffer;

  @typegoose.prop({ required: true })
  public keyDer!: Buffer;

  @typegoose.prop({ required: true, expires: PeerPublicKeyData.TTL_DAYS * SECONDS_IN_A_DAY })
  public creationDate!: Date;
}

@typegoose.index({ peerPrivateAddress: 1, ccaId: 1 }, { unique: true })
export class CCAFulfillment {
  @typegoose.prop({ required: true })
  public peerPrivateAddress!: string;

  @typegoose.prop({ required: true })
  public ccaId!: string;

  @typegoose.prop({ required: true, expires: 0 })
  public ccaExpiryDate!: Date;
}

@typegoose.index(
  {
    parcelId: 1,
    peerGatewayPrivateAddress: 1,
    recipientEndpointAddress: 1,
    senderEndpointPrivateAddress: 1,
  },
  { unique: true },
)
export class ParcelCollection {
  @typegoose.prop({ required: true })
  public peerGatewayPrivateAddress!: string;

  @typegoose.prop({ required: true })
  public senderEndpointPrivateAddress!: string;

  @typegoose.prop({ required: true })
  public recipientEndpointAddress!: string;

  @typegoose.prop({ required: true })
  public parcelId!: string;

  @typegoose.prop({ required: true, expires: 0 })
  public parcelExpiryDate!: Date;
}
