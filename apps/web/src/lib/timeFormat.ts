/** Formats virtual simulation milliseconds into `MM:SS.d` with tabular readability. */
export function formatVirtualTime(ms: number): string {
  const safeMs = Math.max(0, ms);
  const totalTenths = Math.round(safeMs / 100);
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const secs = totalSeconds % 60;
  const mins = Math.floor(totalSeconds / 60);
  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  return `${mm}:${ss}.${tenths}`;
}
