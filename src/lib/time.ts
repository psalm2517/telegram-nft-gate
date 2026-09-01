/** All timestamps are stored as ISO-8601 UTC strings so D1 rows stay human-readable. */
export type Iso = string;

export const nowIso = (d: Date = new Date()): Iso => d.toISOString();

export const addHours = (iso: Iso, hours: number): Iso =>
  new Date(Date.parse(iso) + hours * 3_600_000).toISOString();

export const addSeconds = (iso: Iso, seconds: number): Iso =>
  new Date(Date.parse(iso) + seconds * 1000).toISOString();

/** True when `iso` is strictly in the past relative to `reference`. */
export const isBefore = (iso: Iso, reference: Iso): boolean => Date.parse(iso) < Date.parse(reference);

export const hoursBetween = (from: Iso, to: Iso): number =>
  (Date.parse(to) - Date.parse(from)) / 3_600_000;
