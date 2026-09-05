/**
 * Adapter selection. The one place that knows which backend is in use.
 *
 * Swapping the demo for the real thing is editing config.js and nothing else.
 * If a screen ever needs to know which adapter it is talking to, that is a bug
 * in the screen - except for the one honest exception, `isMock`, which the
 * sign-in screen uses to decide whether to print a magic link on the page
 * instead of sending it by email.
 */

import { CONFIG } from '../config.js';
import { assertImplementsAdapter } from './adapter.js';
import { createMockAdapter } from './mock/mockAdapter.js';

let instance = null;

export async function getAdapter() {
  if (instance) return instance;

  if (CONFIG.backend === 'supabase') {
    const mod = await import('./supabase/supabaseAdapter.js');
    instance = assertImplementsAdapter(
      await mod.createSupabaseAdapter(CONFIG.supabase),
      'supabaseAdapter',
    );
  } else {
    instance = assertImplementsAdapter(createMockAdapter(), 'mockAdapter');
  }

  return instance;
}

/** Test seam: drop the cached adapter so a suite can start clean. */
export function __resetAdapter() {
  instance = null;
}
