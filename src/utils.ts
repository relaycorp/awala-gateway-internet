export function convertDateToTimestamp(date: Date): number {
  return Math.floor(date.getTime() / 1_000);
}
