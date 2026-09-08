# Urenplatform — v1

Opdrachten plaatsen, erop reageren, uren indienen en goedkeuren.
A marketplace for freelance assignments, plus the hours approval loop.

Two halves sharing one data port:

- **The approval loop** — steps 1–3 of `v1-functional-spec.md`: data model,
  audit log, magic-link auth, the freelancer entry grid (F2), and the client
  approve/reject view with versioning (C1).
- **The marketplace** — companies post projects, freelancers apply with a
  profile, and an application runs `submitted → screening call → hired`. Plus
  self-service sign-up and CV import. These reverse decisions the spec made
  deliberately; each reversal is documented where it lands.

Invoicing is **not** here: the freelancer and the company each raise their own.

**Live:** enable Pages first — see [Deploying](#deploying).

---

## What this build is

The spec describes a system whose whole point is that *"the approved number and
the invoiced number are the same number by construction"*. That guarantee is
server-side by nature. GitHub Pages serves static files and nothing else.

Two later decisions changed what that sentence promises. Invoices are raised by
the freelancer and the company in **their own systems**, not by the platform —
so the approved figure is frozen, versioned and audited here, and then copied
out by hand. "By construction" became "if you copy it correctly". This is an
approval tool, not a billing system. See
[`docs/open-items.md`](docs/open-items.md) item 2b.

So this build is deliberately split:

| Layer | Today | Next |
|---|---|---|
| Screens, rules, validation | Static, on GitHub Pages | Unchanged |
| Data, auth, state transitions | **In the browser** (`localStorage`) | Supabase: Postgres + RLS + edge functions |

Every screen talks to a **data port** (`src/data/adapter.js`) and to nothing
else. Two implementations exist — the browser-local one that ships now, and a
Supabase skeleton with its schema already written. Swapping them is one line in
`src/config.js`. See [`docs/architecture.md`](docs/architecture.md).

### What that means in practice

The deployed demo is **honest about its limits and says so on every page**:

- Data lives in one browser. A freelancer on a laptop and an approver on a
  phone do not see each other's work.
- Nothing is enforced against a determined user; anyone with a console can
  rewrite `localStorage`.
- No email is sent. The magic link is printed on the screen instead.

It is a complete, clickable walkthrough of the approval loop — enough to put in
front of the first client and the first freelancer and find out what is wrong
with it. It is **not** something to run a real placement through. That needs
the Supabase step: [`docs/supabase-migration.md`](docs/supabase-migration.md).

---

## Running it locally

No Node, no npm, no build step. The only requirement is serving over HTTP —
ES modules will not load over `file://`.

```bash
powershell -ExecutionPolicy Bypass -File tools/serve.ps1
```

Then open <http://localhost:5500/>. With Node or Python available instead:

```bash
npx serve . ; # or: python -m http.server 5500
```

## Tests

169 tests, run in the browser at **`/tests.html`**. They cover the fee and VAT
arithmetic, both state machines, the compliance absences of spec §6, the
append-only audit log, the versioning guarantee, translation parity, sign-up
and CV parsing, and the full loops end to end against the mock adapter.

Storage is snapshotted and restored, so running them does not disturb demo
data. CI runs the same page headless on every push.

---

## Deploying

The workflow is committed and needs one setting turned on:

1. **Settings → Pages → Source → GitHub Actions**
2. Push to `main`.

The workflow (`.github/workflows/deploy.yml`) refuses to deploy if:

- anything secret-shaped is committed to client code,
- any relative import fails to resolve (a typo would otherwise be a blank page),
- the test suite fails.

> **The repository must be public** for Pages on the free tier, so the served
> code is public. Nothing secret may enter `src/config.js`. Supabase's anon key
> is designed to be public and is fine there; a service-role key is not.

---

## Layout

```
index.html            the whole application, one document
tests.html            the suite
src/
  config.js           backend selection, locale, version. No secrets, ever.
  main.js             routes and the session guard
  app/                router, shell
  domain/             pure rules: money, dates, state machine, authorisation
  data/
    adapter.js        the port every screen talks to
    mock/             browser-local implementation (ships today)
    supabase/         schema.sql + adapter skeleton (next)
  i18n/               nl + en, key parity enforced by a test
  ui/                 screens and components
  test/               runner and suites
docs/                 architecture, compliance, migration
tools/serve.ps1       local static server, Windows, no dependencies
```

## Documents

- [`docs/architecture.md`](docs/architecture.md) — the trust boundary, why hash
  routing, why no framework, and what changes under Supabase.
- [`docs/compliance.md`](docs/compliance.md) — the Wet DBA absences from spec §6
  as a code-review checklist. **Read before adding a field to a timesheet.**
- [`docs/supabase-migration.md`](docs/supabase-migration.md) — the step-by-step
  from demo to something a real placement can run on.
- [`docs/open-items.md`](docs/open-items.md) — spec §10, and what each unanswered
  question currently defaults to in code.

## Language

Dutch and English ship together; Dutch is the default and the browser's
preference is honoured when it matches. Invoices are raised outside the
platform, so nothing here governs their language. Every string lives in
`src/i18n/`, and a test fails the build if the two tables drift apart.
