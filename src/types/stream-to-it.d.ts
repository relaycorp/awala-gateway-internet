declare module 'stream-to-it' {
  import { Readable } from 'stream';

  export function source(source: Readable): IterableIterator<any>;
}
