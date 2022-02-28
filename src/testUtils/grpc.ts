import { Metadata, ServerDuplexStream } from '@grpc/grpc-js';
import { Duplex } from 'stream';

export class MockGrpcBidiCall<Input, Output> extends Duplex {
  // tslint:disable-next-line:readonly-array readonly-keyword
  public input: Input[] = [];
  // tslint:disable-next-line:readonly-array readonly-keyword
  public output: Output[] = [];

  public readonly metadata: Metadata;

  constructor() {
    super({ objectMode: true });

    this.metadata = new Metadata();

    // Mimic what the gRPC server would do
    this.on('error', () => this.end());

    jest.spyOn(this, 'emit' as any);
    jest.spyOn(this, 'on' as any);
    jest.spyOn(this, 'end' as any);
    jest.spyOn(this, 'write' as any);
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

  public end(cb?: () => void): void {
    super.end(cb);
    this.emit('end');
  }

  public getPeer(): string {
    return '127.0.0.1';
  }

  public convertToGrpcStream(): ServerDuplexStream<Input, Output> {
    // Unfortunately, ServerDuplexStream's constructor is private so we have to resort to this
    // ugly hack
    return this as unknown as ServerDuplexStream<Input, Output>;
  }
}
