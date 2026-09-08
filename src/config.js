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
  // Live on Postgres since 8 September 2026.
  //
  // What this cost: the demo is gone. There are no seeded accounts and no
  // walkthrough data — everyone signs up, and the first person to register a
  // KvK number owns that organisation. Reverting is one word here plus a
  // deploy, and the mock adapter is untouched and still passes its tests, so
  // the demo can come back at any time.
  //
  // What it does not change: not one line in src/ui/. That was the point of
  // the data port.
  backend: 'supabase',

  supabase: {
    url: 'https://hmvyurrdwyxvrubaesua.supabase.co',
    // The anon key. Public by design — it is a claim about which project you
    // are talking to, not a permission. Everything it can reach is decided by
    // RLS and by the grants in 007. A service-role key would be a different
    // matter entirely and must never appear here; CI refuses the deploy.
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhtdnl1cnJkd3l4dnJ1YmFlc3VhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4NzE3MTgsImV4cCI6MjEwNDQ0NzcxOH0.N4SBlqsWvdGJ7Gz297-BpchI1qgxx2_lYm4m9-Bmvg8',
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
  adminUrl: 'https://supabase.com/dashboard/project/hmvyurrdwyxvrubaesua/editor',

});
