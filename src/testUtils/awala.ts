import { Parcel } from '@relaycorp/relaynet-core';

export const GATEWAY_INTERNET_ADDRESS = 'kings-landing.relaycorp.cloud';
export const PEER_INTERNET_ADDRESS = 'braavos.relaycorp.cloud';

export interface GeneratedParcel {
  readonly parcel: Parcel;
  readonly parcelSerialized: ArrayBuffer;
}
