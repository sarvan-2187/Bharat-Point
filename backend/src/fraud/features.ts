/**
 * The nine model features, built from BharatPoint data and nothing else.
 *
 * Rule: a feature that cannot be sourced is reported as missing, with the
 * reason. It is never defaulted, estimated or guessed, because a made-up value
 * would produce a confident-looking score that means nothing.
 *
 * What is sourced from where:
 *   TransactionAmount (INR)  the locked transaction amount, paise / 100
 *   CustAccountBalance       the customer's balance at the (mock) bank, paise / 100; missing if the bank cannot say
 *   age                      whole years from the customer's date of birth, if one is on file
 *   gender_num               needs the operator's mapping file; the model card does not say how it was encoded
 *   location_code            same: needs the mapping file
 *   hour, day_of_week, month, is_weekend   from the transaction's creation time (see ASSUMPTIONS)
 *
 * This file imports nothing from the app, so tests can import it safely.
 */
export const FEATURES = [
  'age',
  'gender_num',
  'location_code',
  'CustAccountBalance',
  'TransactionAmount (INR)',
  'hour',
  'day_of_week',
  'month',
  'is_weekend',
] as const;
export type FeatureName = (typeof FEATURES)[number];

/** Conventions the model card does not state, recorded with every assessment so nobody mistakes them for facts. */
export const ASSUMPTIONS = [
  'time features use Asia/Kolkata local time',
  'day_of_week: Monday=0 ... Sunday=6 (pandas convention)',
  'is_weekend: Saturday or Sunday',
  'CustAccountBalance is the balance before this payment, in rupees',
];

export interface FeatureMap {
  source: string;
  gender: Record<string, number>;
  location: Record<string, number>;
}

export interface FeatureInputs {
  amountMinor: number;
  balanceMinor: number | null;
  dateOfBirth: string | null; // YYYY-MM-DD
  gender: string | null;
  location: string | null;
  at: Date;
  map: FeatureMap;
}

export interface Missing {
  feature: FeatureName;
  reason: string;
}

/** Parse and validate the operator-supplied encoding file. Throws with the exact problem. */
export function parseFeatureMap(raw: unknown): FeatureMap {
  const o = raw as { source?: unknown; gender?: unknown; location?: unknown } | null;
  const table = (name: 'gender' | 'location'): Record<string, number> => {
    const t = o?.[name];
    if (typeof t !== 'object' || t === null || Array.isArray(t)) throw new Error(`feature map: "${name}" must be an object`);
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(t)) {
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error(`feature map: ${name}["${k}"] must be a non-negative whole number`);
      out[k.trim().toUpperCase()] = v;
    }
    return out;
  };
  if (typeof o?.source !== 'string' || !o.source.trim()) throw new Error('feature map: "source" must say where these codes come from');
  return { source: o.source, gender: table('gender'), location: table('location') };
}

const IST_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  weekday: 'short',
});
const WEEKDAY: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

function istParts(at: Date) {
  const p = Object.fromEntries(IST_PARTS.formatToParts(at).map((x) => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), dow: WEEKDAY[p.weekday!]! };
}

/** Whole years between a YYYY-MM-DD birth date and `at` (IST calendar date), or null if the date is not usable. */
export function ageAt(dateOfBirth: string, at: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const now = istParts(at);
  let age = now.year - y;
  if (now.month < mo || (now.month === mo && now.day < d)) age -= 1;
  return age >= 0 && age <= 120 ? age : null;
}

export function buildFeatures(i: FeatureInputs): { features: Record<FeatureName, number> | null; missing: Missing[] } {
  const missing: Missing[] = [];
  const need = (feature: FeatureName, reason: string) => missing.push({ feature, reason });

  const age = i.dateOfBirth ? ageAt(i.dateOfBirth, i.at) : null;
  if (age === null) need('age', i.dateOfBirth ? 'date of birth on file is not usable' : 'no date of birth on file');

  const genderKey = i.gender?.trim().toUpperCase() ?? null;
  const gender = genderKey === null ? undefined : i.map.gender[genderKey];
  if (gender === undefined) need('gender_num', genderKey === null ? 'no gender on file' : `no encoding for "${genderKey}" in the feature map`);

  const locKey = i.location?.trim().toUpperCase() ?? null;
  const location = locKey === null ? undefined : i.map.location[locKey];
  if (location === undefined) need('location_code', locKey === null ? 'no location on file' : `no encoding for "${locKey}" in the feature map`);

  if (i.balanceMinor === null) need('CustAccountBalance', 'the bank did not return a balance');

  if (missing.length > 0) return { features: null, missing };

  const t = istParts(i.at);
  return {
    missing,
    features: {
      age: age!,
      gender_num: gender!,
      location_code: location!,
      CustAccountBalance: i.balanceMinor! / 100,
      'TransactionAmount (INR)': i.amountMinor / 100,
      hour: t.hour,
      day_of_week: t.dow,
      month: t.month,
      is_weekend: t.dow >= 5 ? 1 : 0,
    },
  };
}
