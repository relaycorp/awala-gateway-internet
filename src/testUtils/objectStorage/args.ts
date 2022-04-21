import { StoreObject } from '@relaycorp/object-storage';

export interface CallArgs {}

export interface DeleteObjectArgs extends CallArgs {
  readonly key: string;
  readonly bucket: string;
}

export interface GetObjectArgs extends CallArgs {
  readonly key: string;
  readonly bucket: string;
}

export interface ListObjectKeysArgs extends CallArgs {
  readonly prefix: string;
  readonly bucket: string;
}

export interface PutObjectArgs extends CallArgs {
  readonly object: StoreObject;
  readonly key: string;
  readonly bucket: string;
}
