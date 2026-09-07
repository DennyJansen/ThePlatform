/**
 * Build configuration.
 *
 * This file is served as-is to the browser and the repository is public,
 * because GitHub Pages on the free tier cannot serve a private repo. Nothing
 * secret may ever be written here. Supabase's anon key is designed to be
 * public and is fine; a service-role key, an SMTP password or an API secret is
 * not, and would be compromised the moment it is pushed.
 *
 * The rule is simple: if leaking a value would matter, it belongs in a
 * Supabase edge function's environment, not in this file.
 */

export const CONFIG = Object.freeze({
  /**
   * 'mock'     - browser-local. What GitHub Pages serves today.
   * 'supabase' - Postgres, row-level security, edge functions.
   *
   * Flipping this is the entire migration as far as the frontend is concerned.
   * See docs/supabase-migration.md.
   */
  backend: 'mock',

  supabase: {
    url: '',
    anonKey: '',
  },

  /** Default UI language. Spec section 10 leaves this open; Dutch is the
   *  default because the first placement, the client and the invoices are. */
  defaultLocale: 'nl',

  /** Locales with a complete string table in src/i18n. */
  locales: ['nl', 'en'],

  /** Shown in the header so a tester can say which build they are looking at. */
  version: '0.1.0',

  /**
   * Where ops does its work. Spec section 1 is explicit that there is no
   * bespoke internal console in v1; under Supabase this is the project's table
   * editor. Empty means the link is hidden.
   */
  adminUrl: '',

  /**
   * The platform's own company details, as they must appear on an invoice.
   *
   * Dutch law requires the issuer's name, address, KvK and BTW number on every
   * invoice. These are empty on purpose: buildInvoiceSet() refuses to produce
   * a document for a party that is missing them, so an incomplete setup fails
   * loudly rather than shipping something that looks like an invoice and is
   * not a valid one.
   *
   * Fill these in before step 4 goes anywhere near a real month. Nothing here
   * is secret — it is printed on every invoice — so it is fine in a public
   * repository.
   */
  platform: {
    name: '',
    kvk_number: '',
    vat_number: '',
    address: '',
    billing_email: '',
    iban: '',
    /** Prefix for the platform's own invoice numbers. See docs/open-items.md. */
    invoice_prefix: 'PF',
  },
});
