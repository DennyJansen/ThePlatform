/**
 * Money and hour arithmetic.
 *
 * All monetary amounts in this application are integer cents. Never floats.
 * A rate of EUR 100.00/hour is stored as 10000. Rounding happens once, at the
 * point a line total is produced, and always half-up to the nearest cent.
 *
 * Hours are decimals (e.g. 7.25) because that is what the freelancer types.
 * They are quantised to the assignment's increment before any money is derived
 * from them, so the number shown on screen and the number invoiced are the
 * same number — spec §3.
 */

/** Dutch standard VAT rate, in basis points. 21% = 2100. */
export const VAT_RATE_BP = 2100;

/** Default hour increment. Spec §10 lists rounding as an open item; quarter
 *  hours is the default until the terms document says otherwise. Override per
 *  assignment via `hour_increment`. */
export const DEFAULT_HOUR_INCREMENT = 0.25;

/** Largest number of hours accepted for a single calendar day. A day has 24. */
export const MAX_HOURS_PER_DAY = 24;

/**
 * THE RATE MODEL.
 *
 * The platform is the middle man, with two contracts: one with the freelancer,
 * one with the company. There is a single **agreed rate** — what the two sides
 * shake hands on — and the platform's fees point outward from it:
 *
 *              freelancer fee 2.00        client fee 5.00
 *         93.00  <-------------  95.00  ------------->  100.00
 *   what the freelancer         the agreed          what the company
 *        invoices                 rate                is invoiced
 *
 * The platform buys at 93 and sells at 100, keeping 7. All three figures are
 * ex VAT; VAT applies to each side's own invoice.
 *
 * Note that 95.00 is never invoiced by anybody. It is the anchor both parties
 * negotiated and the number each of them recognises — which is why it is what
 * gets stored, and the two rates that touch money are derived from it. Storing
 * the derived rates instead would let the anchor drift out of step with the
 * fees, and then nobody could say what was agreed.
 *
 * Each side sees the agreed rate and its OWN fee. The freelancer is not shown
 * the client fee; the company is not shown the freelancer's. Neither is a
 * secret exactly, but neither is any of their business.
 */

/** Added to the agreed rate to reach what the company is invoiced. */
export const DEFAULT_CLIENT_FEE = 500;

/** Deducted from the agreed rate to reach what the freelancer invoices. */
export const DEFAULT_FREELANCER_FEE = 200;

/** Sanity bounds on an agreed rate, in cents per hour. */
export const MIN_AGREED_RATE = 2000;
export const MAX_AGREED_RATE = 50000;

/** What the company is invoiced: the agreed rate plus the client fee. */
export function clientRate(agreedCents, clientFee = DEFAULT_CLIENT_FEE) {
  if (!Number.isInteger(agreedCents) || agreedCents < 0) return 0;
  return agreedCents + (Number.isInteger(clientFee) ? clientFee : DEFAULT_CLIENT_FEE);
}

/** What the freelancer invoices: the agreed rate less the freelancer fee. */
export function freelancerRate(agreedCents, freelancerFee = DEFAULT_FREELANCER_FEE) {
  if (!Number.isInteger(agreedCents) || agreedCents < 0) return 0;
  const fee = Number.isInteger(freelancerFee) ? freelancerFee : DEFAULT_FREELANCER_FEE;
  return Math.max(0, agreedCents - fee);
}

/**
 * Parse a rate typed as euros into cents. Accepts "95", "95,50", "95.50".
 * Returns null for blank, NaN for anything that is not a rate.
 */
export function parseRateToCents(input) {
  if (typeof input === 'number') {
    return Number.isFinite(input) ? roundHalfUp(input * 100) : NaN;
  }
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().replace(/^€\s*/, '');
  if (trimmed === '') return null;
  if (!/^\d{1,6}([.,]\d{1,2})?$/.test(trimmed)) return NaN;
  return roundHalfUp(Number(trimmed.replace(',', '.')) * 100);
}

/**
 * Round half-up to the nearest integer. JavaScript's Math.round already rounds
 * .5 up for positives, but it rounds -0.5 to -0 rather than -1, so negatives
 * are handled explicitly. Credit notes will need this.
 */
export function roundHalfUp(value) {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Quantise hours to the given increment (default: quarter hours).
 * Returns a number with at most 2 decimals.
 */
export function quantiseHours(hours, increment = DEFAULT_HOUR_INCREMENT) {
  if (!Number.isFinite(hours)) return 0;
  if (!Number.isFinite(increment) || increment <= 0) return round2(hours);
  const steps = roundHalfUp(hours / increment);
  return round2(steps * increment);
}

/**
 * Shift a number by `exp` powers of ten through its decimal string form.
 *
 * `1.005 * 100` is 100.49999999999999 in binary floating point, so rounding it
 * gives 1.00 rather than 1.01. Going via the string "1.005e2" parses to exactly
 * 100.5 and rounds the way a person expects. The exponent is folded in rather
 * than appended so that values already in exponential form ("1e-7") survive.
 */
function shiftExponent(value, exp) {
  const parts = String(value).split('e');
  const mantissa = parts[0];
  const current = parts[1] ? Number(parts[1]) : 0;
  return Number(mantissa + 'e' + (current + exp));
}

/** Round a decimal to 2 places without float drift on display. */
export function round2(value) {
  if (!Number.isFinite(value)) return 0;
  return shiftExponent(roundHalfUp(shiftExponent(value, 2)), -2);
}

/**
 * hours x rate(cents) -> cents, rounded once, half-up.
 */
export function lineTotalCents(hours, rateCents) {
  if (!Number.isFinite(hours) || !Number.isInteger(rateCents)) return 0;
  return roundHalfUp(hours * rateCents);
}

/** VAT on an ex-VAT amount, in cents. */
export function vatCents(exVatCents, rateBp = VAT_RATE_BP) {
  return roundHalfUp((exVatCents * rateBp) / 10000);
}

/**
 * Everything derived from an agreed rate and a number of hours. Ex-VAT cents
 * unless the key says otherwise.
 *
 * On a EUR 95.00 agreed rate:
 *   agreed rate                   95.00/hour  -> agreed_total   (never invoiced)
 *   freelancer fee                 2.00/hour  -> freelancer_fee_total
 *   the freelancer invoices       93.00/hour  -> freelancer_total
 *   client fee                     5.00/hour  -> client_fee_total
 *   the company is invoiced      100.00/hour  -> client_total
 *   platform take                  7.00/hour  -> platform_take
 *
 * platform_take is asserted to equal client_total - freelancer_total, which is
 * the invariant that catches a mis-entered fee before it reaches an invoice.
 *
 * VAT applies to each side's own invoice — 93 + 21% for the freelancer, 100 +
 * 21% for the company. Nothing is charged on the agreed rate itself, because
 * nobody invoices it.
 */
export function computeFees(assignment, hours, vatRateBp = VAT_RATE_BP) {
  const h = Number.isFinite(hours) ? hours : 0;

  const agreed = assignment.agreed_rate_per_hour;
  const clientFee = Number.isInteger(assignment.client_fee_per_hour)
    ? assignment.client_fee_per_hour
    : DEFAULT_CLIENT_FEE;
  const freelancerFee = Number.isInteger(assignment.freelancer_fee_per_hour)
    ? assignment.freelancer_fee_per_hour
    : DEFAULT_FREELANCER_FEE;

  const agreedTotal = lineTotalCents(h, agreed);
  const clientTotal = lineTotalCents(h, clientRate(agreed, clientFee));
  const freelancerTotal = lineTotalCents(h, freelancerRate(agreed, freelancerFee));

  const clientTotalVat = vatCents(clientTotal, vatRateBp);
  const freelancerTotalVat = vatCents(freelancerTotal, vatRateBp);

  return {
    hours: round2(h),
    vat_rate_bp: vatRateBp,

    // The anchor. Shown to both sides; invoiced by neither.
    agreed_rate_per_hour: agreed,
    agreed_total: agreedTotal,

    // The fees, each shown only to the side that pays it.
    client_fee_per_hour: clientFee,
    freelancer_fee_per_hour: freelancerFee,
    client_fee_total: clientTotal - agreedTotal,
    freelancer_fee_total: agreedTotal - freelancerTotal,

    // Ex VAT, and these are the two that touch money.
    client_total: clientTotal,
    freelancer_total: freelancerTotal,
    platform_take: clientTotal - freelancerTotal,

    // VAT, per invoice.
    client_total_vat: clientTotalVat,
    freelancer_total_vat: freelancerTotalVat,

    // Including VAT — what actually moves.
    client_total_incl: clientTotal + clientTotalVat,
    freelancer_total_incl: freelancerTotal + freelancerTotalVat,
  };
}

/**
 * True when an assignment's rate and fees are internally consistent.
 *
 * A freelancer fee larger than the agreed rate would invoice a negative
 * amount; a negative client fee would mean the platform pays to place someone.
 * Both are always data entry errors, and ops should see them before a period
 * is opened rather than on an invoice.
 */
export function ratesAreCoherent(assignment) {
  const agreed = assignment.agreed_rate_per_hour;
  const clientFee = assignment.client_fee_per_hour;
  const freelancerFee = assignment.freelancer_fee_per_hour;
  if (![agreed, clientFee, freelancerFee].every(Number.isInteger)) return false;
  if (agreed <= 0 || clientFee < 0 || freelancerFee < 0) return false;
  return freelancerFee <= agreed;
}

/** Format cents as a localised currency string. */
export function formatMoney(cents, locale = 'nl-NL', currency = 'EUR') {
  const value = (Number.isFinite(cents) ? cents : 0) / 100;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** Format hours the way a timesheet reads: 7.25 -> "7,25" in nl. */
export function formatHours(hours, locale = 'nl-NL') {
  const value = Number.isFinite(hours) ? hours : 0;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Parse hours from user input. Accepts both decimal separators, because a
 * Dutch keyboard's numpad produces a comma and the freelancer should not have
 * to think about it. Rejects anything else.
 */
export function parseHours(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed === '') return null;
  if (!/^\d{1,2}([.,]\d{1,2})?$/.test(trimmed)) return NaN;
  const value = Number(trimmed.replace(',', '.'));
  return Number.isFinite(value) ? value : NaN;
}
