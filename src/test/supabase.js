/**
 * The Supabase adapter, checked without a Supabase project.
 *
 * There is a limit to what can be proved here and it is worth being blunt
 * about where it sits. These tests do not connect to anything. They cannot
 * tell you whether a policy allows a read, whether a migration applies
 * cleanly, or whether a function body compiles — plpgsql is not checked until
 * it runs, which is precisely how hire_applicant came to reference three
 * columns that migration 004 had already dropped.
 *
 * What they can do is check that the adapter and the SQL agree about what
 * exists. Every table, view and function the adapter names is read out of the
 * source and looked for in the migrations. That is a text comparison, and it
 * is worth roughly what a text comparison is worth — but it is the exact class
 * of mistake that costs an afternoon when the two files are written a week
 * apart by someone reading the other one from memory. It is what would have
 * caught `open_period` being called and never written.
 *
 * The migrations are fetched rather than imported because they are .sql, and
 * they are served by GitHub Pages alongside everything else, so this runs the
 * same way against the deployed build as it does locally.
 */

import { describe, it, assert } from './runner.js';
import { REQUIRED_METHODS } from '../data/adapter.js';
import { createSupabaseAdapter } from '../data/supabase/supabaseAdapter.js';

const MIGRATIONS = [
  'schema.sql',
  '002a-enum-values.sql',
  '002-marketplace.sql',
  '003-signup.sql',
  '004-agreed-rate.sql',
  '005-membership-and-kvk.sql',
  '006-adapter-gaps.sql',
  '007-revoke-anon.sql',
];

const BASE = new URL('../data/supabase/', import.meta.url);

/** Everything defined across the migrations, read once. */
let sql = null;

async function loadSql() {
  if (sql) return sql;

  const bodies = await Promise.all(MIGRATIONS.map(async (name) => {
    const res = await fetch(new URL(name, BASE));
    if (!res.ok) throw new Error('cannot read ' + name + ': HTTP ' + res.status);
    return res.text();
  }));

  const all = bodies.join('\n');
  const collect = (re) => {
    const found = new Set();
    let m = re.exec(all);
    while (m) {
      found.add(m[1]);
      m = re.exec(all);
    }
    return found;
  };

  sql = {
    text: all,
    files: MIGRATIONS.map((name, i) => ({ name, text: bodies[i] })),
    tables: collect(/create table (?:if not exists )?(\w+)/g),
    views: collect(/create view (\w+)/g),
    functions: collect(/create (?:or replace )?function (\w+)/g),
    // A column dropped by a later migration is not a column, however many
    // earlier migrations still mention it.
    dropped: collect(/drop column (?:if exists )?(\w+)/g),
  };
  return sql;
}

/** The adapter's own source, for reading the names it uses. */
let source = null;

async function loadSource() {
  if (source) return source;
  const res = await fetch(new URL('supabaseAdapter.js', BASE));
  if (!res.ok) throw new Error('cannot read the adapter: HTTP ' + res.status);
  source = await res.text();
  return source;
}

/**
 * SQL with comments removed.
 *
 * These files explain themselves at length and quote the identifiers they are
 * discussing. A test that searched the prose too would either fire on the
 * documentation or force the documentation to dodge a regex, and both are the
 * test shaping the wrong thing.
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

/**
 * The final definition of every function, by name, keyed to its body.
 *
 * Matches the dollar-quoted body specifically rather than "everything up to
 * the next function", so a slice can never swallow the unrelated SQL that
 * sits between two definitions. Later files overwrite earlier ones, which is
 * what `create or replace` means — so what comes out is what the database
 * ends up with.
 */
function finalFunctionBodies(sqlText) {
  const re = /create (?:or replace )?function (\w+)[\s\S]*?\$(\w*)\$([\s\S]*?)\$\2\$/g;
  const bodies = new Map();
  for (const m of sqlText.matchAll(re)) bodies.set(m[1], m[3]);
  return bodies;
}

function namesIn(text, re) {
  const found = new Set();
  let m = re.exec(text);
  while (m) {
    found.add(m[1]);
    m = re.exec(text);
  }
  return found;
}

/* ------------------------------------------------------------------ */

describe('Supabase adapter — shape', () => {
  it('refuses to build without a url and key, rather than half-working', async () => {
    // The failure mode this prevents: CONFIG.backend flipped to 'supabase'
    // with the settings still empty, and every screen showing an empty state
    // that looks like "no data yet" instead of "not configured".
    let caught = null;
    try {
      await createSupabaseAdapter({ url: '', anonKey: '' });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'building with empty settings should throw');
    assert.ok(/config\.js/.test(caught.message),
      'the error should say where to fix it, got: ' + caught.message);
  });

  it('implements every method the port requires', async () => {
    // createSupabaseAdapter cannot be called without a project, so the method
    // list is read from the source. Crude, and it still catches the thing that
    // matters: a port method added later and implemented in only one adapter.
    const text = await loadSource();
    const missing = REQUIRED_METHODS.filter((name) => !new RegExp(
      '(^|[^\\w])(async )?' + name + '\\s*[(:]', 'm',
    ).test(text));
    assert.deepEqual(missing, [], 'not implemented in the Supabase adapter');
  });

  it('checks for a session in every read, rather than trusting RLS to refuse', async () => {
    // RLS cannot distinguish "you may see nothing" from "there is nothing".
    // A signed-out caller gets [] from a policy-filtered select, so a screen
    // renders an empty list where the mock would have thrown not_authorised
    // and bounced them to sign-in.
    //
    // Caught by driving the real adapter against the real database:
    // listAssignments resolved to [] while every other method refused. The
    // fix is a requireMe() at the top of each reader — cheap, and it makes
    // the two backends agree about what being signed out looks like.
    const text = await loadSource();
    const readers = [
      'listAssignments', 'getAssignment', 'listPeriods', 'listAwaitingDecision',
      'listOpenProjects', 'getProject', 'listCompanyProjects',
      'listApplicationsForProject', 'getMyProfile', 'listPendingMembers',
    ];
    const missing = readers.filter((name) => {
      const start = text.indexOf('async ' + name + '(');
      if (start === -1) return true;
      // Look only at the head of the method, before it starts querying.
      return !/requireMe\(\)/.test(text.slice(start, start + 700));
    });
    assert.deepEqual(missing, [], 'reader does not establish a session first');
  });

  it('never sets a status directly — transitions go through the database', async () => {
    const text = await loadSource();
    // `.update({ status: ... })` is allowed in exactly one place: project
    // transitions, which trg_project_transition validates. Anywhere else it
    // would mean a browser deciding a status, which is the whole boundary.
    const updates = (text.match(/\.update\(\{\s*status:/g) || []).length;
    assert.equal(updates, 1,
      'exactly one direct status update is expected (projects); found ' + updates);
  });
});

describe('Supabase adapter — agrees with the migrations', () => {
  it('calls no RPC that the migrations do not define', async () => {
    const [text, db] = await Promise.all([loadSource(), loadSql()]);
    const called = namesIn(text, /\.rpc\('(\w+)'/g);
    assert.ok(called.size > 0, 'expected the adapter to call some functions');

    const missing = [...called].filter((name) => !db.functions.has(name));
    assert.deepEqual(missing, [], 'called by the adapter, defined nowhere in SQL');
  });

  it('reads no table or view that the migrations do not create', async () => {
    const [text, db] = await Promise.all([loadSource(), loadSql()]);
    const used = namesIn(text, /\.from\('(\w+)'\)/g);
    assert.ok(used.size > 0, 'expected the adapter to read some tables');

    const missing = [...used].filter((name) => !db.tables.has(name) && !db.views.has(name));
    assert.deepEqual(missing, [], 'read by the adapter, created nowhere in SQL');
  });

  it('selects no column that a migration has dropped', async () => {
    const [text, db] = await Promise.all([loadSource(), loadSql()]);
    // The specific trap 004 laid: it removed client_rate_per_hour and
    // freelancer_rate_per_hour, and the function that wrote to them stayed.
    // Nothing complains until the first hire.
    const selected = new Set();
    const blocks = text.match(/`[^`]*`/g) || [];
    for (const block of blocks) {
      for (const part of block.replace(/`/g, '').split(',')) {
        const name = part.trim();
        if (/^\w+$/.test(name)) selected.add(name);
      }
    }
    const zombies = [...selected].filter((name) => db.dropped.has(name));
    assert.deepEqual(zombies, [], 'selected by the adapter, dropped by a migration');
  });

  it('reads the project board, never the projects table, for a freelancer', async () => {
    const text = await loadSource();
    const listOpen = text.slice(text.indexOf('async listOpenProjects'));
    const body = listOpen.slice(0, listOpen.indexOf('async getProject'));
    assert.ok(/\.from\('project_board'\)/.test(body),
      'listOpenProjects must read project_board');
    assert.ok(!/\.from\('projects'\)/.test(body),
      'listOpenProjects must not touch the projects table');
  });
});

describe('Supabase migrations — the invariants they exist to hold', () => {
  it('revokes from anon everything it grants to authenticated', async () => {
    // `revoke ... from public` is not a security statement on Supabase.
    // Default privileges grant `anon` its own rights on every new table, view
    // and function in the public schema, and revoking from PUBLIC leaves
    // those untouched. Every earlier migration in this directory made that
    // mistake, and project_board — a security_invoker=off view, so an RLS
    // bypass by design — was readable by the internet as a result.
    //
    // Nothing static could have caught it: the SQL says `revoke`, and it is
    // Postgres's grant model rather than the text that makes it insufficient.
    // It took querying the running database. What this test can do is make
    // sure a NEW grant does not repeat it.
    const db = await loadSql();
    const code = stripComments(db.text);

    const granted = namesIn(code, /grant execute on function (\w+)/g);
    const revoked = namesIn(code, /revoke all on function (\w+)[^;]*from anon/g);

    const missing = [...granted].filter((name) => !revoked.has(name));
    assert.deepEqual(missing, [],
      'granted to authenticated but never revoked from anon');
  });

  it('keeps the RLS-bypassing view away from anon', async () => {
    // project_board runs as its owner and does not apply the policies on
    // `projects`. That is the point of it, and it is exactly why anon must
    // not hold a grant: the anon key ships in a public repository.
    const db = await loadSql();
    const code = stripComments(db.text);
    assert.ok(/revoke all on project_board from anon/.test(code),
      'project_board must be revoked from anon by name, not from public');
  });

  it('grants no function to public, only to authenticated', async () => {
    const db = await loadSql();
    const granted = namesIn(db.text, /grant execute on function ([\w]+)/g);
    assert.ok(granted.size > 0, 'expected some grants');
    assert.ok(!/grant execute on function [^;]*to public/i.test(db.text),
      'a security-definer function granted to public is granted to anonymous');
  });

  it('never adds an enum value and uses it in the same file', async () => {
    // Postgres refuses to use a new enum value in the transaction that added
    // it, and both the Supabase SQL editor and `supabase db push` run a file
    // as one transaction. So a file that does both cannot succeed — ever, on
    // any machine, however it is pasted.
    //
    // 002 did exactly this from the day it was written: it added
    // 'company_admin' to user_role and then referenced it in a check
    // constraint eleven lines later. It went unnoticed because nothing here
    // had been run. Hence 002a-enum-values.sql, and hence this test.
    const db = await loadSql();
    const problems = [];

    for (const file of db.files) {
      const body = stripComments(file.text);
      const added = [...body.matchAll(
        /alter type \w+ add value (?:if not exists )?'(\w+)'/g,
      )].map((m) => m[1]);

      for (const value of added) {
        // Any other quoted occurrence in the same file is a use of it.
        const occurrences = (body.match(new RegExp("'" + value + "'", 'g')) || []).length;
        if (occurrences > 1) {
          problems.push(file.name + " adds and uses '" + value + "'");
        }
      }
    }
    assert.deepEqual(problems, [], 'enum values must be committed before use');
  });

  it('leaves no function reading a column a migration dropped', async () => {
    // The most expensive class of bug in this directory, and the one with no
    // safety net. Postgres tracks view dependencies — 004 could not drop a
    // column out from under project_board, and said so — but a plpgsql body
    // is opaque to it. DROP COLUMN succeeds, the function keeps compiling,
    // and it fails the first time somebody calls it.
    //
    // It has happened three times here: hire_applicant, submit_period and
    // approve_period all kept reading client_rate_per_hour after 004 removed
    // it. Two of those are the approval loop itself. Nothing complained,
    // because nothing had been run.
    const db = await loadSql();
    const bodies = finalFunctionBodies(stripComments(db.text));
    assert.ok(bodies.size > 0, 'expected to find some function bodies');

    const problems = [];
    for (const [name, body] of bodies) {
      for (const column of db.dropped) {
        if (new RegExp('\\b' + column + '\\b').test(body)) {
          problems.push(name + ' still reads ' + column);
        }
      }
    }
    assert.deepEqual(problems, [], 'dropped columns are still referenced');
  });

  it('drops a view before dropping the columns it selects', async () => {
    // 004 dropped projects.freelancer_rate_per_hour at line 71 and
    // project_board, which selects it, at line 85. Postgres refuses:
    //
    //   ERROR: cannot drop column freelancer_rate_per_hour of table projects
    //          because other objects depend on it
    //
    // Within one file, the dependent has to go first. This is a heuristic —
    // it does not know which view selects which column — but the ordering it
    // enforces is the safe one either way, and it is the ordering that was
    // wrong.
    const db = await loadSql();
    const problems = [];

    for (const file of db.files) {
      const body = stripComments(file.text);
      const view = body.search(/drop view/i);
      const column = body.search(/drop column/i);
      if (view !== -1 && column !== -1 && view > column) {
        problems.push(file.name + ' drops a column before the view');
      }
    }
    assert.deepEqual(problems, [], 'drop dependents before dependencies');
  });

  it('gives timesheet_periods no insert, update or delete policy', async () => {
    const db = await loadSql();
    // Absence is the policy: with RLS on and no permissive write policy,
    // every direct write from the browser is refused. Adding one here would
    // let a browser create a period in any status it likes.
    const bad = /create policy \w+ on timesheet_periods for (insert|update|delete|all)/i;
    assert.ok(!bad.test(db.text),
      'timesheet_periods must stay writable only through security-definer functions');
  });

  it('keeps indicative_hours_per_week off assignments', async () => {
    // COMPLIANCE §6, the Wet DBA line. A scope figure belongs on a pitch, not
    // on the thing that governs how someone works. 002 enforces it with a
    // trigger; this checks nobody has added the column anyway.
    const db = await loadSql();
    assert.ok(!/alter table assignments[^;]*indicative_hours_per_week/i.test(db.text),
      'indicative_hours_per_week must never be added to assignments');
    assert.ok(db.functions.has('assignment_has_no_scope_fields'),
      'the trigger that enforces it must exist');
  });

  it('clamps the role a sign-up can claim', async () => {
    // Sign-up metadata is written by a browser. Without the clamp in
    // handle_new_auth_user, "role": "ops" in the sign-up payload is a
    // privilege escalation with no exploit required.
    const db = await loadSql();
    const start = db.text.lastIndexOf('function handle_new_auth_user');
    const body = db.text.slice(start, start + 3000);
    assert.ok(/safe_role/.test(body), 'the role must be clamped, not taken as given');
    assert.ok(!/safe_role\s*:=\s*want_role/.test(body),
      'the clamp must not simply assign the requested role');
  });

  it('never lets a member approve their own request to join', async () => {
    const db = await loadSql();
    const start = db.text.indexOf('function decide_member');
    const body = db.text.slice(start, start + 2000);
    assert.ok(/p_member = auth\.uid\(\)/.test(body),
      'decide_member must refuse when the actor is the member');
  });
});
