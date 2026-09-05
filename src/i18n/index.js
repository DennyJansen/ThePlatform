/**
 * Translation. Two locales, one flat key space, no framework.
 *
 * A missing key returns the key itself rather than an empty string, so a gap
 * is loud in the UI and in a screenshot instead of silently rendering nothing.
 */

import { CONFIG } from '../config.js';
import nl from './nl.js';
import en from './en.js';

const TABLES = { nl, en };
const STORAGE_KEY = 'platform.v1.locale';

let current = CONFIG.defaultLocale;
const listeners = new Set();

function readStoredLocale() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && CONFIG.locales.includes(stored)) return stored;
  } catch (err) {
    /* private mode: fall through to the default */
  }
  return null;
}

/**
 * Locale resolution, in order: an explicit choice the user made before, then
 * the browser's preference if we have a table for it, then the configured
 * default. The browser's preference is consulted but never overrides a choice.
 */
export function initLocale() {
  const stored = readStoredLocale();
  if (stored) {
    current = stored;
    return current;
  }
  const preferred = (navigator.languages || [navigator.language || ''])
    .map((tag) => String(tag).slice(0, 2).toLowerCase())
    .find((tag) => CONFIG.locales.includes(tag));
  current = preferred || CONFIG.defaultLocale;
  return current;
}

export function getLocale() {
  return current;
}

/** BCP 47 tag for Intl. */
export function getIntlLocale() {
  return current === 'nl' ? 'nl-NL' : 'en-GB';
}

export function setLocale(locale) {
  if (!CONFIG.locales.includes(locale)) return;
  current = locale;
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch (err) {
    /* private mode: the choice lasts for the session only */
  }
  document.documentElement.lang = locale;
  for (const fn of listeners) fn(locale);
}

/** Subscribe to locale changes. Returns an unsubscribe function. */
export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Translate `key`, substituting {placeholders} from `vars`.
 * Values are inserted as text by the caller; t() never produces HTML.
 */
export function t(key, vars) {
  const table = TABLES[current] || TABLES[CONFIG.defaultLocale];
  let value = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
  if (value === null) {
    const fallback = TABLES[CONFIG.defaultLocale];
    value = Object.prototype.hasOwnProperty.call(fallback, key) ? fallback[key] : key;
  }
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  ));
}

/**
 * Translate an error into something a person can act on. Unknown codes fall
 * back to a generic message rather than leaking a developer string.
 */
export function tError(err) {
  const code = err && err.code;
  if (!code) return t('error.unknown');
  const message = t(code);
  return message === code ? t('error.unknown') : message;
}

/** Exposed for the key-parity test. */
export const __tables = TABLES;
