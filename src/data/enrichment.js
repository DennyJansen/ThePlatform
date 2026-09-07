/**
 * Company enrichment from a website URL.
 *
 * WHY THIS DOES NOTHING YET, AND WHY THAT IS NOT A BUG.
 *
 * The request was: a company enters their website, the system reads it and
 * fills in their profile. That cannot happen from a page served on GitHub
 * Pages. A browser will not let this code fetch `https://theircompany.nl` —
 * the same-origin policy blocks it, and it stays blocked unless that company's
 * server sends an `Access-Control-Allow-Origin` header naming us, which no
 * company website does. It is not a limitation of effort. The browser refuses.
 *
 * There are three ways out, and only one of them is honest:
 *
 *   1. A server makes the request.  <- this is the plan
 *      A Supabase edge function fetches the page, reads its metadata, and
 *      returns structured fields. It runs on the platform's own infrastructure,
 *      it can respect robots.txt, it can cache, and it fails visibly.
 *
 *   2. A public CORS proxy makes the request.
 *      Works today. Also means every company's URL travels through a stranger's
 *      server, the dependency breaks without warning, and the rate limit is
 *      someone else's decision. Rejected deliberately.
 *
 *   3. Guess from the domain name.
 *      "waterlijninfra.nl" -> "Waterlijn Infra". Cheap, no network, and wrong
 *      often enough to be irritating. Rejected: a prefilled wrong name is worse
 *      than an empty field, because people accept what is already there.
 *
 * So: the URL is collected and stored now, `enrichFromWebsite` returns
 * `{ available: false }`, and the sign-up screen says plainly that the profile
 * is filled in by hand for the moment. When the edge function exists, this file
 * is where it gets wired in and no screen changes.
 */

export const ENRICHMENT_ERROR = Object.freeze({
  NOT_AVAILABLE: 'error.enrichment_unavailable',
});

/**
 * The shape an implementation must return, so the screen can be written once.
 *
 * @typedef {Object} Enrichment
 * @property {boolean} available   false in this build
 * @property {string}  [reason]    translatable code when unavailable
 * @property {string}  [name]      company name from og:site_name or <title>
 * @property {string}  [description] from og:description or meta description
 * @property {string}  [logo_url]  from og:image
 * @property {string}  [sector]    only if the page states it plainly
 * @property {string}  fetched_at  ISO timestamp of the fetch
 */

/**
 * Look up a company from its website.
 *
 * @param {string} websiteUrl  already normalised by assertWebsite()
 * @returns {Promise<Enrichment>}
 */
export async function enrichFromWebsite(websiteUrl) {
  return {
    available: false,
    reason: ENRICHMENT_ERROR.NOT_AVAILABLE,
    url: websiteUrl || null,
    fetched_at: null,
  };
}

/**
 * True when this build can enrich at all. The sign-up screen uses it to decide
 * between "we will fill this in for you" and telling the truth.
 */
export function enrichmentIsAvailable() {
  return false;
}

/**
 * ---------------------------------------------------------------------------
 * The edge function, for whoever implements step 2.
 *
 * Deploy as `supabase/functions/enrich-company/index.ts`. Sketch:
 *
 *   1. Take { url } from the request body. Re-validate it server-side with the
 *      same rules as assertWebsite — never trust a URL the client normalised.
 *   2. Refuse private address space before fetching. A URL pointing at
 *      169.254.169.254 or 10.0.0.0/8 turns this function into a way to read
 *      the platform's own internal network. This is the single most important
 *      line of that function and the easiest one to leave out.
 *   3. Fetch with a timeout (5s), a size cap (~1MB), redirect limit, and a
 *      User-Agent that identifies the platform and links to a page explaining
 *      it. Check robots.txt first; a company that asked not to be crawled has
 *      asked, and this is a business that will have to talk to them later.
 *   4. Parse only the head: og:site_name, og:description, og:image,
 *      <title>, meta[name=description]. Do not read the body. There is no
 *      reliable "what does this company do" in a page body, and pretending
 *      otherwise produces confident nonsense in a company profile.
 *   5. Return the fields with fetched_at, and cache per hostname for a day.
 *
 * Then in this file: replace the body of enrichFromWebsite with an
 * `sb.functions.invoke('enrich-company', { body: { url } })`, and flip
 * enrichmentIsAvailable to read CONFIG.backend === 'supabase'.
 *
 * Everything above the line stays as it is.
 * ---------------------------------------------------------------------------
 */
