/**
 * KvK verification, and keeping recruitment agencies off the platform.
 *
 * WHY THIS DOES NOTHING YET — same reason as enrichment.js. The KvK's
 * Handelsregister API needs an API key, and a key in a public repository is a
 * leaked key. It also has no CORS headers, so a browser could not call it even
 * with one. Verification runs server-side or not at all.
 *
 * What this file is for is deciding *what* the server should check, because
 * that part is a policy question and belongs somewhere reviewable.
 *
 * ---------------------------------------------------------------------------
 * THE AGENCY PROBLEM
 *
 * The goal is to keep recruitment agencies from signing up as "companies" or
 * "freelancers" in order to approach the real ones. The Handelsregister
 * returns each registration's SBI codes — the Dutch standard activity
 * classification — and agencies are classified precisely enough to filter on:
 *
 *   78100  Arbeidsbemiddeling            (employment placement)
 *   78201  Uitzendbureaus                (temp agencies)
 *   78202  Uitleenbureaus                (secondment / detachering)
 *   78300  Overige HRM en personeels-    (payrolling and the rest)
 *          beheer
 *
 * BE CLEAR ABOUT WHAT THIS BUYS. It raises the bar; it does not close the
 * door. An agency can register a second BV with a consultancy SBI, or use a
 * director's personal holding, and walk straight through. What SBI filtering
 * actually gives you is:
 *
 *   - it stops the lazy 90% who sign up under their real registration;
 *   - it gives you a factual reason to refuse, in writing, that is not a
 *     judgement call about who someone is;
 *   - it makes deliberate evasion an act you can point at later, which
 *     matters if you ever remove someone and they object.
 *
 * It also has a false-positive edge: a genuine ZZP interim manager sometimes
 * carries 78100 because they occasionally place people. Refusing outright
 * would lose real supply, so a hit should flag for review, not auto-reject.
 * That distinction is the difference between a filter and a wall, and the
 * flag/reject split is the one design decision here worth arguing about.
 * ---------------------------------------------------------------------------
 */

export const KVK_ERROR = Object.freeze({
  NOT_AVAILABLE: 'error.kvk_check_unavailable',
  NOT_FOUND: 'error.kvk_not_found',
  INACTIVE: 'error.kvk_inactive',
  LOOKS_LIKE_AGENCY: 'error.kvk_looks_like_agency',
});

/**
 * SBI codes that mean "this registration places people for a living".
 *
 * A match flags for review rather than refusing outright — see the note above.
 * Kept as data rather than buried in a condition so that adding or removing a
 * code is a visible change with a reason attached to it.
 */
export const AGENCY_SBI_CODES = Object.freeze([
  { code: '78100', label: 'Arbeidsbemiddeling' },
  { code: '78201', label: 'Uitzendbureaus' },
  { code: '78202', label: 'Uitleenbureaus' },
  { code: '78300', label: 'Overige HRM en personeelsbeheer' },
]);

/** True when any of a registration's SBI codes is on the agency list. */
export function looksLikeAgency(sbiCodes) {
  if (!Array.isArray(sbiCodes)) return false;
  const flagged = new Set(AGENCY_SBI_CODES.map((s) => s.code));
  return sbiCodes.some((code) => flagged.has(String(code).trim()));
}

/** Which codes matched, so a review queue can say why. */
export function agencyMatches(sbiCodes) {
  if (!Array.isArray(sbiCodes)) return [];
  const wanted = new Set(sbiCodes.map((c) => String(c).trim()));
  return AGENCY_SBI_CODES.filter((s) => wanted.has(s.code));
}

/**
 * The shape a verification must return, so the screens can be written once.
 *
 * @typedef {Object} KvkResult
 * @property {boolean} available      false in this build
 * @property {string}  [reason]       translatable code when unavailable
 * @property {boolean} [found]        does this number exist in the register
 * @property {boolean} [active]       is the registration still active
 * @property {string}  [legal_name]   statutaire naam
 * @property {string}  [trade_name]   handelsnaam
 * @property {string[]} [sbi_codes]
 * @property {boolean} [agency_flag]  true when an SBI code is on the list
 * @property {string}  checked_at     ISO timestamp
 */

/**
 * Look a KvK number up in the Handelsregister.
 *
 * @param {string} kvkNumber  eight digits, already normalised by assertKvk()
 * @returns {Promise<KvkResult>}
 */
export async function verifyKvk(kvkNumber) {
  return {
    available: false,
    reason: KVK_ERROR.NOT_AVAILABLE,
    kvk_number: kvkNumber || null,
    checked_at: null,
  };
}

/** True when this build can verify at all. Screens use it to set expectations. */
export function kvkCheckIsAvailable() {
  return false;
}

/**
 * ---------------------------------------------------------------------------
 * The edge function, for whoever implements it.
 *
 * Deploy as `supabase/functions/verify-kvk/index.ts`.
 *
 *   1. Register for the KvK Zoeken API and the Basisprofiel API at
 *      developers.kvk.nl. Zoeken confirms the number exists and returns the
 *      name; Basisprofiel returns the SBI codes, which is the part that
 *      matters here. Both are paid per call above a small free tier, so cache
 *      by KvK number — a registration does not change hourly.
 *   2. Keep the API key in the function's environment. Never in config.js,
 *      never in a migration, never in a client fetch.
 *   3. Return { found, active, legal_name, trade_name, sbi_codes } and let
 *      this module compute agency_flag, so the policy lives in one reviewable
 *      place rather than in the function.
 *   4. On an agency match, DO NOT auto-reject. Set the account to pending
 *      review and tell the person plainly what was flagged and that a human
 *      will look — a false positive that silently fails signup is a real
 *      freelancer you never hear from again.
 *   5. Verify on sign-up, then re-verify on a schedule. A registration that
 *      was a consultancy in January can be an uitzendbureau by June, and the
 *      whole point is to notice.
 *
 * Then replace the body of verifyKvk with an
 * `sb.functions.invoke('verify-kvk', { body: { kvk_number } })` and flip
 * kvkCheckIsAvailable to read CONFIG.backend === 'supabase'.
 *
 * Everything above the line stays as it is.
 * ---------------------------------------------------------------------------
 */
