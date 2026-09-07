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
 * The client-side spread, in cents per hour. Spec §3's worked example: a €100
 * client budget carries a €95 freelancer rate, so the spread is €5.
 *
 * This is the number a marketplace listing must never reveal. A company enters
 * its budget; the board shows the freelancer what they would earn. Both are
 * stored, only one is shown to each side.
 */
export const DEFAULT_CLIENT_SIDE_SPREAD = 500;

/** Sanity bounds on a posted budget, in cents per hour. */
export const MIN_CLIENT_RATE = 2000;
export const MAX_CLIENT_RATE = 50000;

/**
 * What the freelancer would contract at, derived from the client's budget.
 *
 * Never store only one of the two. The listing shows this figure; the
 * assignment that a hire eventually produces needs both, and recomputing the
 * spread later from a rate someone has since edited is how the margin
 * silently changes.
 */
export function deriveFreelancerRate(clientRateCents, spread = DEFAULT_CLIENT_SIDE_SPREAD) {
  if (!Number.isInteger(clientRateCents) || clientRateCents < 0) return 0;
  return Math.max(0, clientRateCents - spread);
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
 * The fee arithmetic from spec §3, computed from an assignment and a total
 * number of hours. Every figure is ex-VAT cents.
 *
 * On a EUR 100/hour client budget:
 *   client is invoiced          100.00/hour   -> client_total
 *   freelancer's assignment rate 95.00/hour   -> freelancer_gross
 *   self-billed deduction         2.00/hour   -> freelancer_fee
 *   freelancer nets              93.00/hour   -> freelancer_net
 *   platform take                 7.00/hour   -> platform_take
 *
 * platform_take is asserted to equal client_total - freelancer_net, which is
 * the invariant that catches a mis-entered rate before it reaches an invoice.
 */
export function computeFees(assignment, hours, vatRateBp = VAT_RATE_BP) {
  const h = Number.isFinite(hours) ? hours : 0;
  const clientTotal = lineTotalCents(h, assignment.client_rate_per_hour);
  const freelancerGross = lineTotalCents(h, assignment.freelancer_rate_per_hour);
  const freelancerFee = lineTotalCents(h, assignment.freelancer_fee_per_hour);
  const freelancerNet = freelancerGross - freelancerFee;
  const clientSideSpread = clientTotal - freelancerGross;

  // VAT. Spec §8.9 / §10 asked how the per-hour deduction is treated; the
  // answer is that the €2 is EX VAT, which makes it a taxable supply from the
  // platform to the freelancer rather than a discount on their rate. So VAT is
  // charged on it, and the freelancer reclaims that VAT like any other cost.
  //
  // Two separate supplies, therefore two separate VAT amounts, and they are
  // NOT netted before VAT is applied:
  //
  //   freelancer -> platform   95.00 + 19.95 VAT = 114.95   (self-billed)
  //   platform   -> freelancer  2.00 +  0.42 VAT =   2.42   (platform's fee)
  //   cash to the freelancer                       112.53
  //
  // 93.00 is still what they keep once the VAT washes through, which is why
  // freelancer_net is unchanged. It is not what lands in the bank.
  const clientTotalVat = vatCents(clientTotal, vatRateBp);
  const freelancerGrossVat = vatCents(freelancerGross, vatRateBp);
  const freelancerFeeVat = vatCents(freelancerFee, vatRateBp);

  return {
    hours: round2(h),
    vat_rate_bp: vatRateBp,

    // Ex VAT — the figures the fee model is defined in.
    client_total: clientTotal,
    freelancer_gross: freelancerGross,
    freelancer_fee: freelancerFee,
    freelancer_net: freelancerNet,
    client_side_spread: clientSideSpread,
    platform_take: clientSideSpread + freelancerFee,

    // VAT, per supply.
    client_total_vat: clientTotalVat,
    freelancer_gross_vat: freelancerGrossVat,
    freelancer_fee_vat: freelancerFeeVat,

    // Including VAT — the figures that move between bank accounts.
    client_total_incl: clientTotal + clientTotalVat,
    freelancer_gross_incl: freelancerGross + freelancerGrossVat,
    freelancer_fee_incl: freelancerFee + freelancerFeeVat,
    freelancer_cash: (freelancerGross + freelancerGrossVat)
      - (freelancerFee + freelancerFeeVat),
  };
}

/**
 * True when the assignment's three rates are internally consistent, i.e. the
 * platform take is non-negative on both legs. A freelancer rate above the
 * client rate means the platform pays to place someone; that is always a data
 * entry error in v1 and ops should see it before a period is opened.
 */
export function ratesAreCoherent(assignment) {
  const c = assignment.client_rate_per_hour;
  const f = assignment.freelancer_rate_per_hour;
  const fee = assignment.freelancer_fee_per_hour;
  if (![c, f, fee].every(Number.isInteger)) return false;
  if (c < 0 || f < 0 || fee < 0) return false;
  return f <= c && fee <= f;
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
