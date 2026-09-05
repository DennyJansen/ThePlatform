/**
 * Browser-local storage for the mock adapter.
 *
 * A single JSON document in localStorage, read whole and written whole. This is
 * not a database and is not pretending to be one: it exists so the six screens
 * can be exercised end to end on GitHub Pages, on one device, before Supabase
 * is wired in. Its one non-negotiable behaviour is that the audit log is append
 * only, because a system whose audit log can be rewritten in development will
 * eventually have one that can be rewritten in production.
 *
 * Data lives per browser. Two people on two laptops do not see each other's
 * work. That is the honest limit of this build; see docs/architecture.md.
 */

const STORAGE_KEY = 'platform.v1.db';
const SCHEMA_VERSION = 1;

/** Tables that may be written by the adapter. */
const TABLES = [
  'organizations',
  'users',
  'assignments',
  'periods',
  'entries',
  'charges',
  'invoices',
  'magic_links',
  'audit_events',
  'session',
];

/** The one append-only table. Spec section 3. */
const APPEND_ONLY = new Set(['audit_events']);

function emptyDb() {
  return {
    schema_version: SCHEMA_VERSION,
    organizations: [],
    users: [],
    assignments: [],
    periods: [],
    entries: [],
    charges: [],
    invoices: [],
    magic_links: [],
    audit_events: [],
    session: null,
  };
}

/**
 * localStorage is unavailable in private windows on some browsers and throws on
 * access rather than returning null. Everything that touches it is wrapped, and
 * the app falls back to an in-memory document that lasts for the tab.
 */
let memoryFallback = null;
let usingFallback = false;

function readRaw() {
  if (usingFallback) return memoryFallback;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    usingFallback = true;
    return memoryFallback;
  }
}

function writeRaw(value) {
  if (usingFallback) {
    memoryFallback = value;
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch (err) {
    usingFallback = true;
    memoryFallback = value;
  }
}

export function storageIsPersistent() {
  return !usingFallback;
}

/** Read the whole document. Returns a fresh empty one if nothing is stored. */
export function load() {
  const raw = readRaw();
  if (!raw) return emptyDb();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schema_version !== SCHEMA_VERSION) return emptyDb();
    // Guarantee every table exists even if the stored document predates one.
    const db = emptyDb();
    for (const table of TABLES) {
      if (table === 'session') {
        db.session = parsed.session || null;
      } else if (Array.isArray(parsed[table])) {
        db[table] = parsed[table];
      }
    }
    return db;
  } catch (err) {
    return emptyDb();
  }
}

export function save(db) {
  writeRaw(JSON.stringify(db));
}

/**
 * Read-modify-write under one function so no caller can forget to save, and so
 * the append-only invariant is checked on every write rather than by
 * convention. `mutate` receives the document and may return a value, which is
 * passed back to the caller.
 */
export function transact(mutate) {
  const before = load();
  const beforeAudit = before.audit_events;
  const after = load();
  const result = mutate(after);

  assertAuditAppendOnly(beforeAudit, after.audit_events);

  save(after);
  return result;
}

/**
 * The invariant: existing audit rows may not be changed or removed, only new
 * ones appended. Throws rather than silently repairing, because a violation
 * means a bug in an adapter, not a data problem.
 */
export function assertAuditAppendOnly(before, after) {
  if (!Array.isArray(after)) {
    throw new Error('audit_events must be an array');
  }
  if (after.length < before.length) {
    throw new Error('audit_events is append only: rows were removed');
  }
  for (let i = 0; i < before.length; i += 1) {
    if (JSON.stringify(before[i]) !== JSON.stringify(after[i])) {
      throw new Error('audit_events is append only: row ' + i + ' was modified');
    }
  }
}

export function clear() {
  save(emptyDb());
}

export function isEmpty(db) {
  return db.users.length === 0 && db.assignments.length === 0;
}

/**
 * Identifiers. crypto.randomUUID is available in every browser that supports
 * ES modules and dialog elements, which is the floor this app already sets.
 */
export function newId(prefix) {
  const uuid = (window.crypto && window.crypto.randomUUID)
    ? window.crypto.randomUUID()
    : String(Date.now()) + Math.random().toString(16).slice(2);
  return prefix ? prefix + '_' + uuid.slice(0, 12) : uuid;
}

/** A URL-safe single-use token for a magic link. */
export function newToken() {
  const bytes = new Uint8Array(24);
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export const __testing = { STORAGE_KEY, SCHEMA_VERSION, APPEND_ONLY, emptyDb };
