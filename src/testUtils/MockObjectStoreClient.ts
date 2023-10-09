import { ObjectStoreClient, StoreObject } from '@relaycorp/object-storage';

type Bucket = Map<string, StoreObject>;

export class MockObjectStoreClient implements ObjectStoreClient {
  protected readonly objectsByBucket = new Map<string, Bucket>();

  async deleteObject(key: string, bucketName: string): Promise<void> {
    const bucket = this.getBucket(bucketName);
    bucket?.delete(key);
  }

  async getObject(key: string, bucketName: string): Promise<StoreObject | null> {
    const bucket = this.getBucket(bucketName);
    return bucket?.get(key) ?? null;
  }

  async *listObjectKeys(prefix: string, bucketName: string): AsyncIterable<string> {
    const bucket = this.getBucket(bucketName);
    const keys = bucket ? Array.from(bucket.keys()) : [];
    yield* keys.filter((key) => key.startsWith(prefix));
  }

  async putObject(object: StoreObject, key: string, bucketName: string): Promise<void> {
    const bucket = this.getOrCreateBucket(bucketName);
    bucket.set(key, object);
  }

  private getBucket(bucketName: string): Bucket | undefined {
    return this.objectsByBucket.get(bucketName);
  }

  private getOrCreateBucket(bucketName: string): Bucket {
    let bucket = this.getBucket(bucketName);
    if (!bucket) {
      bucket = new Map();
      this.objectsByBucket.set(bucketName, bucket);
    }
    return bucket;
  }

  public reset(): void {
    this.objectsByBucket.clear();
  }
}
