declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

// Moments are in seconds and durations in milliseconds; the brands keep them apart.
export type EpochSeconds = Brand<number, "EpochSeconds">;
export type Millis = Brand<number, "Millis">;

export const asEpochSeconds = (n: number): EpochSeconds => n as EpochSeconds;
export const asMillis = (n: number): Millis => n as Millis;

export const nowEpochSeconds = (): EpochSeconds =>
  Math.floor(Date.now() / 1000) as EpochSeconds;
