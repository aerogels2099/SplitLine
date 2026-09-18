/**
 * Branded time types. `date` fields are epoch SECONDS and `time` fields are
 * MILLISECONDS; branding makes mixing them a compile error.
 */

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Epoch timestamp in seconds (API `date`). */
export type EpochSeconds = Brand<number, "EpochSeconds">;
/** Duration in milliseconds (API `time`). */
export type Millis = Brand<number, "Millis">;

export const asEpochSeconds = (n: number): EpochSeconds => n as EpochSeconds;
export const asMillis = (n: number): Millis => n as Millis;

export const nowEpochSeconds = (): EpochSeconds =>
  Math.floor(Date.now() / 1000) as EpochSeconds;

export const epochSecondsToDate = (s: EpochSeconds): Date => new Date(s * 1000);

/** Seconds elapsed between two epoch timestamps (b - a). */
export const secondsBetween = (a: EpochSeconds, b: EpochSeconds): number => b - a;

export const addMillis = (a: Millis, b: Millis): Millis => (a + b) as Millis;
export const subMillis = (a: Millis, b: Millis): Millis => (a - b) as Millis;

/** Format a duration as m:ss or h:mm:ss (e.g. 930527 -> "15:30"). */
export function formatMillis(ms: Millis | number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
