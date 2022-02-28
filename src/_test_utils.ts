import bufferToArray from 'buffer-to-arraybuffer';

export function arrayBufferFrom(value: string): ArrayBuffer {
  return bufferToArray(Buffer.from(value));
}
