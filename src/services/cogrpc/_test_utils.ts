import grpc from 'grpc';
import { Duplex } from 'stream';

export class MockGrpcBidiCall<Input, Output> extends Duplex {
  // tslint:disable-next-line:readonly-array readonly-keyword
  public input: Input[] = [];
  // tslint:disable-next-line:readonly-array readonly-keyword
  public output: Output[] = [];

  public readonly metadata: grpc.Metadata;

  constructor() {
    super({ objectMode: true });

    this.metadata = new grpc.Metadata();
  }

  public _read(_size: number): void {
    while (this.output.length) {
      const canPushAgain = this.push(this.output.shift());
      if (!canPushAgain) {
        return;
      }
    }

    this.push(null);
  }

  public _write(value: Input, _encoding: string, callback: (error?: Error) => void): void {
    this.input.push(value);
    callback();
  }

  public convertToGrpcStream(): grpc.ServerDuplexStream<Input, Output> {
    // Unfortunately, ServerDuplexStream's constructor is private so we have to resort to this
    // ugly hack
    return (this as unknown) as grpc.ServerDuplexStream<Input, Output>;
  }
}
jest.spyOn(MockGrpcBidiCall.prototype, 'emit');
jest.spyOn(MockGrpcBidiCall.prototype, 'on');
jest.spyOn(MockGrpcBidiCall.prototype, 'end');
jest.spyOn(MockGrpcBidiCall.prototype, 'write');
