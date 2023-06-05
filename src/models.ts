/* tslint:disable:readonly-keyword max-classes-per-file */

import { index, prop } from '@typegoose/typegoose';

export class ConfigItem {
  @prop({ required: true, unique: true })
  public key!: string;

  @prop({ required: true })
  public value!: string;
}

@index({ peerId: 1, ccaId: 1 }, { unique: true })
export class CCAFulfillment {
  @prop({ required: true })
  public peerId!: string;

  @prop({ required: true })
  public ccaId!: string;

  @prop({ required: true, expires: 0 })
  public ccaExpiryDate!: Date;
}

@index(
  {
    parcelId: 1,
    privatePeerId: 1,
    recipientEndpointId: 1,
    senderEndpointId: 1,
  },
  { unique: true },
)
export class ParcelCollection {
  @prop({ required: true })
  public privatePeerId!: string;

  @prop({ required: true })
  public senderEndpointId!: string;

  @prop({ required: true })
  public recipientEndpointId!: string;

  @prop({ required: true })
  public parcelId!: string;

  @prop({ required: true, expires: 0 })
  public parcelExpiryDate!: Date;
}
