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

### One agreed rate, two fees pointing outward

The platform is the middle man, with a contract on each side. There is a single
**agreed rate** — what the freelancer and the company shake hands on — and the
fees point outward from it:

```
                 freelancer fee 2.00        client fee 5.00
            93.00  <-------------  95.00  ------------->  100.00
      what the freelancer         the agreed          what the company
           invoices                 rate                is invoiced
```

The platform buys at 93 and sells at 100, keeping 7. Every figure is ex VAT;
VAT applies to each side's own invoice — 21% of 93, and 21% of 100.

**95.00 is never invoiced by anybody.** It is the anchor both parties
negotiated and the number each of them recognises, which is why it is the one
that gets *stored*. The two rates that touch money are derived from it wherever
they are needed. Storing them instead would be storing two numbers that must
differ by a fee — a pair that can drift, after which nobody can say what was
agreed. There is a test asserting a project carries exactly one `*_rate_per_hour`
field.

**Each side sees the agreed rate and its own fee.** The freelancer's screens do
not show the €5; the company's do not show the €2. Neither is a secret exactly,
but neither is any of their business, and showing a freelancer that the company
pays €5 more invites a conversation about the €5 rather than about the work.

This replaced an earlier model in which a posting carried a client budget and a
derived freelancer rate, with the spread hidden. That needed a `project_board`
view whose whole job was omitting a column. A posting now carries one rate that
both sides are meant to see, so there is nothing to hide and nothing to forget
to hide.

**The platform does not raise any invoice.** Decided after v1: the freelancer
and the company each invoice from their own systems. So spec §8.1's
self-billing authorisation is no longer a clause this code depends on, there
are no invoice numbers to allocate, and `CONFIG` holds no company details.

This is a real weakening of §3's guarantee and worth stating plainly. "The
approved number and the invoiced number are the same number **by
construction**" becomes "…the same number **if whoever raises the invoice
copies it correctly**". The platform still freezes the figure, versions it and
audits it — but the last step out to a document is now manual, and nothing
here can detect a typo in someone's accounting software. That is the trade of
being an approval tool rather than a billing system.

VAT is charged once on the line total, never per hour and multiplied. There is
a test asserting the two agree at awkward hour counts, since that divergence
would show up as an invoice disagreeing with the confirmation by a cent.

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

## The marketplace

The marketplace was added after v1, reversing spec §1's exclusion of matching
and profiles. Architecturally it changed three things.

**A fourth role.** `company_admin`, scoped to one organisation, posts and
manages that organisation's projects and decides on applications. It is
deliberately not the same role as `approver`: §2 gives the approver one narrow
power — approving hours on one named assignment — and the compliance story
leans on that narrowness. One person may hold both.

**One rate on a posting.** A company states the rate it is offering the
freelancer, and is shown live what it will itself pay once the client fee is
added. The board shows the freelancer that same agreed rate, and beneath it
what they would actually invoice after their own fee — both, because the first
is what they negotiate on and the second is what reaches their bank. Being
shown only one of those is how someone feels misled two months later.

See "One agreed rate, two fees pointing outward" above for the model itself.
`projectForFreelancer()` survives from the earlier design, now stripping only
`created_by` — it stays because it is where a company-only field would have to
be removed if a posting ever acquires one, and the data layer is the right
place for that rather than whichever template happens to render it.

**A second state machine.** Applications run
`submitted → screening → hired`, with `reject` available to the company at
both steps and `withdraw` to the freelancer. Transitions are actor-owned:
`APPLICATION_ACTOR` says which side may fire each one, so a freelancer cannot
hire themselves and a company cannot withdraw someone's application. Hiring
straight from `submitted` is refused — the screening call is a required step,
not a convention.

A hire produces a **pending** assignment, not an active one. Two people have
had a video call; §8's nine contract clauses do not exist yet. Ops sets the
final rates, names an approver and uploads the agreement. Until then no period
opens, and the `active_needs_approver` constraint refuses to let it go live
half-configured.

## Sign-up, CV import, and the thing that cannot work

**Sign-up reverses §4/F1's "accounts are created by ops"**, which a marketplace
cannot live with. It does not reverse "no passwords": sign-up collects details
and sends a magic link, which is the mechanism §4/F1 already specified and the
only honest one in a build served from a public repository.

Two rules carry weight:

- **An account is not an assignment.** Signing up gets someone an account and a
  profile. Ops still creates assignments, with rates and a signed contract.
- **Sign-up is not an account oracle.** A public form that says "that address
  is already registered" answers a question anyone can ask about anyone. An
  existing address gets a sign-in link instead, and the response is
  byte-identical either way — no `outcome` field, no different wording. There
  is a test for the shape of both responses.

Under Supabase the same clamp matters more: sign-up metadata is written by the
browser, so someone can claim `"role": "ops"`. The trigger in `003-signup.sql`
forces anything outside `{freelancer, company_admin}` to freelancer. That
`CASE` is the difference between a sign-up form and privilege escalation.

**CV import is regexes and a fixed vocabulary, and says so.** No model, because
an API key in a public repo is a leaked API key. `.txt` reads directly, `.docx`
is unpacked by about sixty lines of ZIP reading plus the platform's own
`DecompressionStream` — no library — and `.pdf` loads pdf.js from a pinned CDN
build, on demand, only when someone actually uploads one.

It **prefills and stops**. Fields are marked "from your CV", nothing is saved
until the person presses Save, and it never guesses a rate: a wrong number in a
field nobody checked is worse than an empty field. An image-only PDF is
reported as a scan rather than as a failure to understand, because those call
for different responses and OCR is not in this build.

**Website enrichment cannot work here at all.** A browser will not fetch
`https://theircompany.nl` from this origin — the same-origin policy blocks it
and no company website sends the header that would allow it. So the URL is
collected and stored, `enrichFromWebsite` returns `{ available: false }`, and
the sign-up form says the profile is filled in by hand for now. A public CORS
proxy would work today and was rejected: every company's URL through a
stranger's server, a dependency that breaks without warning. The edge function
that replaces it is sketched at the bottom of `src/data/enrichment.js`,
including the SSRF check that is the easiest part to leave out.

## What changes under Supabase

| Concern | Mock | Supabase |
|---|---|---|
| Auth | token printed on screen | `auth.signInWithOtp`, real email |
| Read scoping | a filter in JS | row-level security |
| Draft entry writes | direct | direct — RLS permits it only while `draft` |
| submit / approve / reject | adapter method | `rpc()` into a security-definer function |
| Audit | array append + invariant check | insert-only table, no update/delete rule |
| Ops console | none (audit shown on C2) | the project's table editor |
| Project board | a JS filter | the `project_board` view |
| Profile visibility | `assertProfileVisibleTo` | the `read_profiles` policy |
| Application transitions | adapter method | `rpc()` into a security-definer function |
| Scope never on an assignment | omitted by `buildAssignmentFromHire` | `trg_assignment_no_scope` |
| Sign-up | `signUpFreelancer` / `signUpCompany` | `signInWithOtp` + the `trg_new_auth_user` trigger |
| Role clamp on sign-up | the adapter sets it | the `CASE` in `handle_new_auth_user` |
| CV file | filename only | the file in Supabase Storage |
| Website enrichment | returns `{available: false}` | an `enrich-company` edge function |

The screens do not change. That is the point of the port.
