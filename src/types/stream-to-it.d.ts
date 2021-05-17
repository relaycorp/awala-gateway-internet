declare module 'stream-to-it' {
  import { Duplex, Readable } from 'stream';

  export function source(source: Readable): IterableIterator<any>;

  export function duplex(stream: Duplex): {
    readonly sink: IterableIterator<any>;
    readonly source: IterableIterator<any>;
  };
}
