// tslint:disable:max-classes-per-file

import { StoreObject } from '@relaycorp/object-storage';

import {
  CallArgs,
  DeleteObjectArgs,
  GetObjectArgs,
  ListObjectKeysArgs,
  PutObjectArgs,
} from './args';

export class MockMethodCall<CallArguments extends CallArgs, ResultType> {
  // tslint:disable-next-line:readonly-keyword
  private _wasCalled = false;
  // tslint:disable-next-line:readonly-keyword
  private args: CallArguments | undefined = undefined;

  private readonly error: Error | null = null;
  private readonly result: ResultType | undefined = undefined;

  constructor(result: ResultType);
  constructor(error: Error);
  constructor(output: ResultType | Error) {
    if (output instanceof Error) {
      this.error = output;
    } else {
      this.result = output;
    }
  }

  public get wasCalled(): boolean {
    return this._wasCalled;
  }

  public get arguments(): CallArguments | undefined {
    return this.args;
  }

  public call(args: CallArguments): ResultType {
    if (this._wasCalled) {
      throw new Error('Method was already called');
    }

    // tslint:disable-next-line:no-object-mutation
    this._wasCalled = true;
    // tslint:disable-next-line:no-object-mutation
    this.args = args;
    if (this.error) {
      throw this.error;
    }
    return this.result!!;
  }
}

export class DeleteObjectCall extends MockMethodCall<DeleteObjectArgs, void> {}

export class GetObjectCall extends MockMethodCall<GetObjectArgs, StoreObject | null> {}

export class ListObjectKeysCall extends MockMethodCall<ListObjectKeysArgs, AsyncIterable<string>> {}

export class PutObjectCall extends MockMethodCall<PutObjectArgs, void> {}
