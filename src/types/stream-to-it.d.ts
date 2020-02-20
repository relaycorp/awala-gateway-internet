declare module 'stream-to-it' {
  import { Readable, Transform } from 'stream';

  export function source(source: Readable): IterableIterator<any>;
  export function transform(stream: Transform): IterableIterator<any>;
}
