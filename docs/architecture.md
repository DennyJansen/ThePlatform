# Architecture

## The trust boundary

This is the only diagram that matters.

```
  Browser (GitHub Pages, public, untrusted)
  ┌───────────────────────────────────────────────┐
  │  ui/screens   ──▶  data/adapter.js (the port) │
  │  domain/rules  ← used for rendering only      │
  └────────────────────────┬──────────────────────┘
                           │
              ┌────────────┴─────────────┐
              │                          │
   TODAY: mock adapter        NEXT: Supabase adapter
   localStorage, same tab      Postgres + RLS + RPC
              │                          │
   authority is in the         authority is in the
   browser (i.e. nowhere)      database, where it is real
```

`src/domain/rules.js` is imported by the frontend so a button can be greyed out
before a round trip. That is a rendering convenience. It is **never** the
authority. Under Supabase the same checks are duplicated in SQL
(`src/data/supabase/schema.sql`) — deliberately, because the browser copy can
be edited by anyone with a console and the SQL copy cannot.

Nothing about this changes when the backend does. The screens already ask for
outcomes (`submitPeriod`, `approvePeriod`) rather than for rows, so they cannot
develop opinions about storage.

## Why no framework and no build step

GitHub Pages serves static files. A build step would mean a toolchain to
install, a lockfile to keep current, and a CI job that can break independently
of the application — for six screens with no shared client state to speak of.
Plain ES modules load natively in every browser this app supports.

The cost is real and worth naming: no JSX, no reactive re-render, and manual
DOM work in `src/ui/dom.js`. If this application grows past a dozen screens,
that trade flips. It has not yet.

`innerHTML` appears nowhere. All text goes in through `textContent`, because a
client name and a rejection comment are attacker-controlled the moment there is
a real database behind them.

## Why hash routing

A GitHub Pages project site is served from `/<repo>/` and has no rewrite rules.
A deep link to `/<repo>/period` 404s before any JavaScript runs. With a hash,
every URL is the same document, so emailed links and refreshes both work.

Email is the real interface (spec §5); the screens are where links land. That
makes deep links load-bearing and the ugly URL a fair price.

## Layers, and what may import what

```
domain/   pure. imports nothing outside domain/.
data/     imports domain/. never imports ui/.
ui/       imports domain/ and the adapter port. never imports data/mock/* —
          with one exception, noted below.
app/      wiring: router, shell.
```

The exception: `ui/screens/signin.js` imports `DEMO_ACCOUNTS` from the mock
seed to render the demo buttons, and hides them when `adapter.isMock` is false.
It is a demo affordance with a visible off switch, not a leak of the mock into
the UI layer.

## Money

Integer cents throughout. Never floats. A rate of €100.00/hour is `10000`.
Rounding happens once, at the point a line total is produced, half-up.

Hours are decimals because that is what a person types, and are quantised to
the assignment's increment *before* any money is derived from them. This is
what makes the number on the screen and the number on the invoice the same
number rather than two numbers that usually agree.

`round2` routes through the decimal string form (`"1.005e2"`) rather than
multiplying by 100, because `1.005 * 100` is `100.49999999999999` in binary
floating point and rounds the wrong way. There is a test for exactly this.

## The audit log

Append only. `src/data/mock/store.js` checks the invariant on **every** write
and throws if an existing row changed, moved or vanished. `schema.sql` enforces
the same thing with rules that turn `UPDATE` and `DELETE` on `audit_events`
into no-ops, and grants no write policy to any client role.

Approval events carry the approved figures in their payload rather than leaving
them to be recomputed later. That row is the record an invoice has to match.

## State the UI keeps

Almost none, on purpose. Each screen re-reads from the adapter on render, and a
transition returns the new view rather than patching the old one. The only
client-side state that outlives a render is the locale choice and the
unsaved-changes guard on F2.

## What changes under Supabase

| Concern | Mock | Supabase |
|---|---|---|
| Auth | token printed on screen | `auth.signInWithOtp`, real email |
| Read scoping | a filter in JS | row-level security |
| Draft entry writes | direct | direct — RLS permits it only while `draft` |
| submit / approve / reject | adapter method | `rpc()` into a security-definer function |
| Audit | array append + invariant check | insert-only table, no update/delete rule |
| Ops console | none (audit shown on C2) | the project's table editor |

The screens do not change. That is the point of the port.
