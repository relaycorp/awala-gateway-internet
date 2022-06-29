import { ObjectStoreClient, StoreObject } from '@relaycorp/object-storage';

import { DeleteObjectArgs, GetObjectArgs, ListObjectKeysArgs, PutObjectArgs } from './args';
import {
  DeleteObjectCall,
  GetObjectCall,
  ListObjectKeysCall,
  MockMethodCall,
  PutObjectCall,
} from './methodCalls';

export class MockObjectStore implements ObjectStoreClient {
  // tslint:disable-next-line:readonly-array
  constructor(private callQueue: MockMethodCall<any, any>[]) {}

  public get callsRemaining(): number {
    return this.callQueue.length;
  }

  public async deleteObject(key: string, bucket: string): Promise<void> {
    const call = this.getNextCall(DeleteObjectCall);
    const args: DeleteObjectArgs = { key, bucket };
    return call.call(args);
  }

  public async getObject(key: string, bucket: string): Promise<StoreObject | null> {
    const call = this.getNextCall(GetObjectCall);
    const args: GetObjectArgs = { key, bucket };
    return call.call(args);
  }

  public async *listObjectKeys(prefix: string, bucket: string): AsyncIterable<string> {
    const call = this.getNextCall(ListObjectKeysCall);
    const args: ListObjectKeysArgs = { prefix, bucket };
    yield* await call.call(args);
  }

  public async putObject(object: StoreObject, key: string, bucket: string): Promise<void> {
    const call = this.getNextCall(PutObjectCall);
    const args: PutObjectArgs = { object, key, bucket };
    return call.call(args);
  }

  protected getNextCall<Call extends MockMethodCall<any, any>>(
    callClass: new (...args: any) => Call,
  ): Call {
    const call = this.callQueue.shift();
    if (!call) {
      throw new Error('Call queue is empty');
    }
    if (!(call instanceof callClass)) {
      throw new Error(`Next call in queue is not of type ${callClass.name}`);
    }
    return call;
  }
}
