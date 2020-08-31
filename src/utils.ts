import { BinaryLike, createHash } from 'crypto';

export function convertDateToTimestamp(date: Date): number {
  return Math.floor(date.getTime() / 1_000);
}

export function sha256(plaintext: BinaryLike): Buffer {
  return createHash('sha256').update(plaintext).digest();
}

export function sha256Hex(plaintext: BinaryLike): string {
  return sha256(plaintext).toString('hex');
}
