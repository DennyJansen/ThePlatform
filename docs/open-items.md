# Open items

Spec §10 lists nine unanswered questions. Code cannot wait for all of them, so
each one has a **current default** below. A default is not an answer — it is
what the code does until someone decides, and where to change it when they do.

Nothing here is settled by having been implemented.

---

### 1. The per-assignment fixed fee — ANSWERED

**Decided:** the **company** pays it, **when it opens the assignment**. It is a
listing fee for putting work on the platform, not a placement fee — so it is
charged whether or not a hire follows.

Worth being deliberate about that last part, because it is the whole character
of the fee. A company that posts, gets three unsuitable applicants and closes
the project has still paid. That is defensible — you carried the matching cost
either way — but it is the thing a company will query, so the terms should say
it in one sentence rather than leaving it to be discovered.

**Implemented:** `fixed_fee_payer` is `'client'`; `fixed_fee_charged_at` added
in `005-membership-and-kvk.sql`. Charging it is not built — there is no
payments module and invoicing is outside the platform (item 2b).

### 2. VAT treatment of the freelancer-side deduction

**ANSWERED.** Every rate is ex VAT — the agreed €95, the €2 freelancer fee and
the €5 client fee alike.

The fees are applied to the rate **before** any VAT, and VAT is then charged on
each side's own invoice:

| | Ex VAT | VAT 21% | Incl. |
|---|---|---|---|
| The freelancer invoices (95 − 2) | 93.00 | 19.53 | 112.53 |
| The company is invoiced (95 + 5) | 100.00 | 21.00 | 121.00 |
| Platform take | 7.00 | | |

Nothing is charged on the agreed €95, because nobody invoices it — see item 2c.

Charging VAT on 95 and then deducting 2 would overstate the freelancer's
turnover by €2/hour and hand the Belastingdienst VAT on money they never
received. There is a test for that specific mistake.

**Implemented in:** `computeFees()` in `src/domain/money.js`. Tested under
"VAT — spec §8.9, answered". VAT is applied once to each line total, not per
hour and multiplied, with a test that the two agree at awkward hour counts.

### 2b. Who raises the invoices — ANSWERED: not the platform

**Decided:** the freelancer and the company each raise their own invoices, in
their own systems. The platform generates no documents and allocates no
invoice numbers. Spec §8.1's self-billing authorisation stops being a clause
this code depends on, and the invoice-numbering problem it created disappears
with it.

**The cost, stated plainly:** §3's "the approved number and the invoiced number
are the same number *by construction*" becomes "*…if whoever raises the invoice
copies it correctly*". The platform freezes, versions and audits the figure;
the last step out to a document is manual and invisible from here. That is the
difference between a billing system and an approval tool.

`invoiced` and `paid` stay as period statuses that ops sets against documents
raised elsewhere — which is what §1 already said about payment.

### 2d. What each fee is *for* — ANSWERED

Worth writing down, because it is what you say when someone asks:

| | | |
|---|---|---|
| €2/hour | freelancer | the contract and the system |
| €5/hour | company | matching, the contract and the system |
| fixed fee | company | opening the assignment on the platform |

The two hourly fees are not the same fee split in two — they buy different
things, and the €5 is larger because matching is the part you actually do.
That is the sentence to have ready when a company compares notes with a
freelancer, which they now can (see below).

### 2c. How the platform collects its fee — ANSWERED

**Decided:** the platform is the middle man, with a contract on each side. One
agreed rate, and the two fees point outward from it:

```
             freelancer fee 2.00        client fee 5.00
        93.00  <-------------  95.00  ------------->  100.00
  what the freelancer         the agreed          what the company
       invoices                 rate                is invoiced
```

- The freelancer invoices **93.00** — the agreed rate less their fee.
- The company is invoiced **100.00** — the agreed rate plus its fee.
- The platform buys at 93 and sells at 100, keeping **7.00**.
- Every figure is ex VAT. VAT applies to each side's own invoice: 21% of 93,
  21% of 100. Nothing is charged on the agreed rate, because nobody invoices it.

**The fees are not confidential.** Each side's screens lead with its own fee
because that is what it needs to act on — a freelancer checking a submission
wants the number they will invoice — but a freelancer and a company are free to
compare what each of them pays, and the terms say what that is. No screen, and
no row-level policy, exists to keep one from finding out about the other.

Worth knowing what that rules out: there is no version of this platform where
you quote a company €100 and a freelancer €95 and rely on them not comparing.
The margin has to survive both of them knowing it. It does — €7 on €95 is a
defensible intermediation fee — but it is now a number you explain rather than
a number you keep.

**Implemented in:** `computeFees()`, `clientRate()` and `freelancerRate()` in
`src/domain/money.js`; migration `004-agreed-rate.sql`. The stored field is
`agreed_rate_per_hour` and the two invoiced rates are derived — a test asserts
a project carries exactly one `*_rate_per_hour` column, because two stored
numbers that must differ by a fee are a pair that can drift.

This supersedes the earlier model, in which a company entered a budget of 100
and the freelancer's 95 was derived by subtracting a hidden spread. That model
had no place to put the €2 once the platform stopped invoicing, and it hid a
number from the freelancer that they are now meant to negotiate on.

### 3. Payout timing versus client payment terms (§8.4) — ANSWERED

**Decided:** the platform pays the freelancer **when the client has paid**.

This is the answer that costs you nothing in working capital and costs the
freelancer their certainty, so it has to be in their contract in plain words —
not implied by silence. A freelancer who assumes 30 days and discovers they are
waiting on a client they have never met will not take a second placement.

Two things follow that are not built and will be wanted:

- The freelancer needs to **see where the money is**. "Approved, awaiting the
  client" is a different state from "approved" and a different one again from
  "paid". The period statuses already carry `invoiced` and `paid`; something
  has to set them, and today nothing does.
- A client who pays late is now the freelancer's problem as much as yours.
  Whatever you do about that — chasing, a backstop after N days — is a
  commercial decision, but the freelancer should know which it is.

### 4. Expense cap and receipt retention — ANSWERED in mechanism

**Decided:** the freelancer uploads the receipt, the company approves it. Which
is exactly the flow §4/C1 already describes and the data model already carries
(`additional_charges.receipt_file`, approve/reject separate from hours).

**Still open, and small:** whether there is a cap above which a charge needs
pre-agreement, and how long receipts are kept. Both belong with the CV
retention question below rather than being answered separately.

### 5. Partial months — ANSWERED

**Decided:** pro-rate **hours only**. The fixed fee is charged when the
assignment opens (item 1), so a mid-month start does not touch it.

Already how it works: `withinAssignment()` bounds every entry by the
assignment's dates, days outside render greyed and non-enterable, and the
domain refuses an entry on one even through a crafted payload.

### 6. Hour rounding — decimal, quarter, or half

**Default:** quarter hours. `DEFAULT_HOUR_INCREMENT = 0.25`, overridable per
assignment via `assignments.hour_increment`.
Hours are quantised on the way in, so the number shown, stored and invoiced is
one number. Changing the default changes nothing already stored.
**Change in:** `src/domain/money.js`, or per assignment in the database.

### 7. Language — UI English or Dutch

**Decided:** both, Dutch by default. The browser's preference is honoured when
it matches a table we have; an explicit choice always wins and is remembered.
**Invoices are raised outside the platform** (see item 2b), so nothing here
governs their language any more.

### 8. Approval window — ANSWERED: silence never approves

**Decided:** silence does **not** count as approval. `auto_approve_enabled`
stays false permanently; the field and the scheduled job stay as scaffolding
but must not be switched on.

The due date therefore stays **hidden**, and that is not an oversight. Spec §7:
*"Do not display a due date while nothing happens on that date. A deadline with
no consequence teaches clients the deadline is decoration."* Reminders are
still fine — an email at T-2 days is a nudge, not a deadline.

What this costs you: an approver who ignores a submission blocks the
freelancer's invoice indefinitely, and there is no automatic escape. That is
the deliberate trade, and chasing is now an ops job rather than a code path.

### 9. Rejection procedure, termination, rate change (§8)

**Rejection — built.** Reject → the decided version is frozen → a pre-filled
successor is created. If the signed terms describe a different correction path,
this is the part that changes.

**§8.1 (self-billing) is no longer among them** — see item 2b.

**Termination — ANSWERED: one calendar month, given before month end.** Notice
served in September ends the assignment on 31 October; notice served on
1 October ends it on 30 November.

Not built, and worth knowing what that means. `assignments.end_date` exists and
`withinAssignment()` already refuses hours outside it, so *recording* a
termination works today — ops sets the date. What does not exist:

- nothing calculates the date from a notice, so ops does the arithmetic and
  ops can get it wrong;
- nothing warns either party that a month is ending;
- an assignment ending mid-period is fine (hours stop at `end_date`), but the
  final month's approval still has to happen after the freelancer has gone,
  and nobody is reminded of it.

The last one is the one that bites: a placement ends, everyone moves on, and a
month of approved hours sits unapproved because the approver stopped looking.

---


## Added by sign-up and CV import

### CV and profile retention — PARTLY ANSWERED

**Decided:** a company loses access to a freelancer's profile **when the
application closes**. Rejected or withdrawn ends it; submitted, screening and
hired keep it open, because a hire is an ongoing relationship.

**Implemented:** `PROFILE_VISIBLE_STATUSES` and `assertProfileVisibleTo()` in
`src/domain/marketplace.js`, the `read_profiles` policy in
`005-membership-and-kvk.sql`, and tests under "Compliance §6". A rejected
application no longer keeps a CV readable, which is what stops a company
assembling a candidate database one refusal at a time.

**Still open:** how long the platform itself keeps a CV once an account goes
quiet, and what deletion on request has to reach. Not urgent while only
filenames are stored and the text never leaves the browser; urgent the day
files go into Supabase Storage.

### Company website enrichment

**Default: collected, not used.** The URL is stored on the organisation.
Nothing fetches it, because a browser cannot. The edge function that will is
sketched at the bottom of `src/data/enrichment.js`.

### Verifying KvK numbers, and keeping agencies out — DESIGNED, NOT BUILT

**Decided:** both companies and freelancers give a KvK number at sign-up, and
the goal is to keep recruitment agencies from signing up in order to approach
the real parties.

**Built now:** the number is collected on both sign-up forms, validated to
eight digits, and stored. `src/data/kvk.js` holds the policy — which SBI codes
mean "this registration places people for a living" — and the edge function
sketch.

**Not built:** the lookup itself. The Handelsregister API needs a key and sends
no CORS headers, so it runs server-side or not at all. Same blocker as
enrichment, same fix, same step.

**Read `src/data/kvk.js` before relying on this.** SBI filtering raises the bar
and does not close the door: an agency can register a second BV with a
consultancy code and walk through. What it buys is the lazy majority, a factual
reason to refuse that is not a judgement about a person, and evidence if
someone evades it deliberately. It also has a false-positive edge — genuine ZZP
interim managers sometimes carry 78100 — so **a match must flag for review, not
auto-reject**. Losing a real freelancer to a silent signup failure costs more
than letting one agency through.

### Whether a company sign-up should be reviewed

**Default: no review.** Anyone with a valid-looking KvK number gets an account
and can post immediately. The KvK check above is the intended gate; until it
exists there is none. Fine while you know every company by name.

### Joining an existing organisation — ANSWERED: an existing member approves

**Decided:** the first person to register a KvK number is active — there is
nobody to ask. Everyone after them arrives **pending** and an existing active
member lets them in or declines.

This was a real hole, not a nicety. KvK numbers are printed on company
websites. Before this, anyone who could read a competitor's footer could sign
up, be silently added to their organisation, and read their projects and
applicants.

A pending member gets one screen saying their request is with a colleague. They
cannot list projects, read applicants, post, or approve themselves — that last
check is in `assertMemberDecision` and has its own test, because it is the one
that looks too obvious to write and is exactly the one that gets left out.

**Implemented:** `MEMBERSHIP_STATUS`, `isCompanyAdminFor()` requiring active,
`assertMemberDecision()`, the pending-requests panel on the company screen, and
`005-membership-and-kvk.sql` — where the gate goes into `is_company_admin_for`,
which every projects, applications and profiles policy already routes through,
so it closes everywhere at once rather than policy by policy.

**Worth knowing:** if the only active admin of an organisation leaves, nobody
can approve anyone. Ops can fix it in the table editor. It will happen.

### Sourcer versus this platform — ANSWERED

**Decided: one system.** This platform is authoritative for who is available
and what is open. Nothing to keep in step with a spreadsheet.

## Added by the Supabase adapter

### The migrations have never been run — OPEN, and the largest unknown left

Six SQL files, roughly 900 lines, written against the schema rather than
against a running Postgres. Nothing in `src/data/supabase/` has ever been
executed. The adapter has never opened a connection.

That is not a small caveat and it should not be read as one. Everything else in
this repository has been exercised in a browser, most of it in CI on every
push. This part has been exercised by reading.

**What is genuinely checked.** `src/test/supabase.js` compares the adapter
against the SQL: every table, view and function the adapter names must exist
somewhere in the migrations, no column it selects may have been dropped by a
later migration, and the invariants the schema exists to hold — no write policy
on `timesheet_periods`, no function granted to `public`, the sign-up role
clamp, the self-approval check — are asserted as text.

**What is not, and cannot be, without a database.** Whether a policy actually
permits a read. Whether a migration applies cleanly, or in the order given.
Whether a `plpgsql` body compiles — it is not checked until it runs, and that
is exactly how the next item happened.

### `hire_applicant` has been broken since migration 004 — FOUND, FIXED IN 006

004 dropped `assignments.client_rate_per_hour`,
`assignments.freelancer_rate_per_hour` and
`projects.freelancer_rate_per_hour`. `hire_applicant`, written in 002, still
inserted into all three. It would have failed on the first hire with "column
does not exist".

Nobody noticed because nobody had run it. Postgres does not check a function
body against the schema until the function executes, so a migration that
changes a column set has to grep the functions — there is no compiler to do it.

Repaired in `006-adapter-gaps.sql`, along with five other things writing the
adapter turned up: `open_period` (which did not exist at all, so a month could
not be opened), `set_outreach_consent`, `audit_for_assignment`,
`my_applications`, `applications_for_project`, and a trigger making project
transitions legal-or-refused rather than whatever a browser PATCHes.

**The pattern behind five of those six.** The v1 policies were written for the
timesheet flows, where every reader is a party to the assignment. The
marketplace reads across that boundary: a company reading an applicant's name,
a freelancer reading the title of a project they have no policy on. RLS cannot
express "you may read this row because of a relationship elsewhere", so those
reads go through narrow security-definer functions instead. Each takes the
smallest argument that identifies the relationship and returns only what the
screen needs — a general one would defeat the design it is patching.

### What running it will cost — an estimate, not a promise

Expect a session of failures on first apply: statement ordering, enum values
added and used in the same transaction (Postgres refuses that), a cast or two.
Boring, individually obvious, and not knowable in advance from here.

Keep the fixes in the migration files rather than in the SQL editor. A database
repaired by hand is a database the next environment cannot reproduce, and the
whole reason these are files is that there will be a next environment.
