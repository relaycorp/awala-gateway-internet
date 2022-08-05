import { Parcel } from '@relaycorp/relaynet-core';

export interface GeneratedParcel {
  readonly parcel: Parcel;
  readonly parcelSerialized: ArrayBuffer;
}
