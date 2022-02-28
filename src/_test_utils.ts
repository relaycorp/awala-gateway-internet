import bufferToArray from 'buffer-to-arraybuffer';
import { BinaryLike, createHash, Hash } from 'crypto';

export const UUID4_REGEX = expect.stringMatching(/^[0-9a-f-]+$/);

export function arrayBufferFrom(value: string): ArrayBuffer {
  return bufferToArray(Buffer.from(value));
}

function makeSHA256Hash(plaintext: BinaryLike): Hash {
  return createHash('sha256').update(plaintext);
}

export function sha256Hex(plaintext: string): string {
  return makeSHA256Hash(plaintext).digest('hex');
}

export function sha256(plaintext: BinaryLike): Buffer {
  return makeSHA256Hash(plaintext).digest();
}
