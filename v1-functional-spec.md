# V1 Functional Spec — Freelance Assignment Platform

**Status:** decisions, not conclusions. Every section is open to challenge.
**Purpose of v1:** run one real placement end to end, under this platform's own
commercial and compliance terms. Not a demo, not a product.

---

## 1. What v1 is and is not

**In scope**

- One assignment, one freelancer, one client, one named approver.
- Monthly cycle: freelancer submits hours → client approves or rejects →
  platform self-bills in the freelancer's name → platform invoices the client.
- Additional charges (expenses/travel) as a separate approvable object.
- An immutable audit trail of every state change.

**Explicitly not building**

| Not building | Handled instead by |
|---|---|
| Matching / search / freelancer profiles | Sourcer, in a spreadsheet |
| Contract generation and e-signature | Signed outside, PDF uploaded |
| PSP integration, payouts, payment status sync | Manual bank transfer, marked paid in admin |
| Ops console / internal dashboards | Framework admin panel (Django admin, Rails, Retool) |
| Messaging, notifications centre, profile settings | Email |
| Mobile apps | Responsive web; hour entry must work on a phone |
| Multi-tenancy niceties, org hierarchies, SSO | One org, one approver |

The ops console is the biggest scope risk in this build. It is the most common
way a lean MVP becomes a six-month project. One operator with one placement does
not need bespoke internal tooling.

---

## 2. Roles

| Role | Can do |
|---|---|
| `freelancer` | Enter and submit hours and charges for own assignments; view own invoices |
| `approver` | View and approve/reject submitted periods for own org's assignments; view invoices |
| `ops` | Everything, via the admin panel. No custom UI. |

One approver per assignment in v1. No delegation, no finance read-only role.

---

## 3. Data model

```
Organization
  name, kvk_number, vat_number, billing_email, payment_terms_days

User
  email, name, role (freelancer | approver | ops), organization (nullable)
  auth: magic link only

Assignment
  freelancer (User), organization, approver (User)
  client_rate_per_hour        # e.g. 100.00 — what the client is invoiced
  freelancer_rate_per_hour    # e.g. 95.00  — client_rate minus platform client-side fee
  freelancer_fee_per_hour     # e.g. 2.00   — deducted on the self-billed invoice
  fixed_fee_amount, fixed_fee_payer   # per-assignment one-off; payer TBC
  start_date, end_date, status (active | ended)
  contract_pdf                # uploaded, not generated
  approval_window_days        # nullable
  auto_approve_enabled        # boolean, default FALSE

TimesheetPeriod
  assignment, year, month
  status: draft | submitted | rejected | approved | invoiced | paid
  submitted_at, decided_at, decided_by, rejection_comment
  version (int)               # rejection creates v2, v1 retained

TimeEntry
  period, date, hours (decimal)

AdditionalCharge
  period, description, amount_gross, receipt_file
  status: pending | approved | rejected, decision_comment

Invoice
  period, direction (to_client | self_billed_to_freelancer)
  number, issue_date, lines[], subtotal, vat_amount, total, pdf

AuditEvent
  actor, assignment, object_type, object_id, action, payload_json, created_at
  APPEND ONLY. No update, no delete, ever.
```

**Fee arithmetic** (confirm this reading): on a €100/hour client budget the
client is invoiced €100/hour; the assignment's freelancer rate is €95/hour;
the self-billed invoice deducts €2/hour, netting the freelancer €93/hour.
Platform take = €5 (client-side spread) + €2 (freelancer deduction) = €7/hour.

**State machine** — all transitions server-side, all logged:

```
draft ──submit──> submitted ──approve──> approved ──invoice──> invoiced ──> paid
                      │
                      └──reject──> rejected ──(new version)──> draft
```

Nothing is editable once `submitted`. Rejection does not mutate the submitted
version; it creates a successor. This is the point of the whole system — the
approved number and the invoiced number are the same number by construction.

---

## 4. Screens

Six. No tab bar. Email is the real interface; these are where the links land.

### F1 — Sign in (both roles)
Email field, one button, magic link. Link valid 24h, single use. No passwords,
no account creation flow — accounts are created by ops when an assignment is set up.

### F2 — Freelancer: current period
The default landing page for a freelancer.

- Header: client name, assignment title, rate, period month, status badge.
- Entry grid: one row per calendar day of the month. Date, weekday, hours field.
  Weekends visually de-emphasised but enterable. Running total, prominent.
- Additional charges: list plus "Add charge" (description, amount, receipt upload).
- If status is `rejected`: the approver's comment shown at the top, previous
  version's numbers pre-filled, editable.
- Primary action: **Submit**. Confirmation step showing total hours, total
  charges, and the resulting invoice amount before commit.
- After submit: grid becomes read-only, status badge changes, no edit affordance.

*Field-level constraints (compliance, not preference):* hours per day only. No
start time, no end time, no break field, no location. See §6.

### F3 — Freelancer: history
Reverse-chronological list of periods: month, hours, status, invoice PDF link
when available. Nothing else.

### C1 — Client: approval view
Landing page for an approver. Empty eleven days out of twelve; the empty state
should say what's expected and when, not "no data".

- Same period object as F2, read-only, plus the decision controls.
- Hours: daily breakdown plus total. Charges: separate section, each with its
  own approve/reject and receipt link.
- Decision on hours: **Approve** or **Reject with comment** (comment mandatory
  on reject). Charges are decided separately — a disputed €40 parking claim must
  not hold up €9,600 of approved hours.
- No partial approval of hours in v1. Approve all or reject with a reason.
- If `approval_window_days` is set, show the date the response is due. Only show
  it if something actually happens on that date (see §7).

### C2 — Client: assignment detail
Freelancer name, dates, rate, contract PDF, hours-to-date, spend-to-date. Read
only. No budget-setting field, no scheduling, no "assign work" action.

### C3 — Client: invoices
List of platform-issued invoices with PDF download. Nothing else.

---

## 5. Email inventory

Seven messages total. Do not add an eighth without removing one.

**To freelancer:** period open (last working day of month) · rejected, with
comment · approved, invoice attached · paid.

**To client:** hours submitted, review requested (with due date if applicable) ·
reminder at T-2 days · invoice issued.

---

## 6. Compliance constraints that show up as absences

These follow from the Wet DBA position (no *gezag*, freelancer determines their
own working method and hours). They are structural, not stylistic — a later
"small usability improvement" that reintroduces any of them is a compliance
regression, so they belong in code review, not just here.

- No start/end time fields, no break tracking, no clock in/out.
- No client-visible or client-editable schedule, roster, or expected-hours field.
- No client-side action that assigns, sequences, or approves *work* — only
  hours as an invoicing basis.
- No presence, location, or activity indicators.
- No "employee-lookalike" surfaces: no company announcements, no org chart,
  no perks, no internal comms.
- Direct outreach based on profile data requires opt-in captured at signup.
  Not in v1 scope, but the consent field belongs in the User model now.

---

## 7. Approval window

Current decision: reminder only, no auto-approve. **Engineering position:** build
the fields (`approval_window_days`, `auto_approve_enabled`) and the scheduled
job, ship with auto-approve disabled. Enabling it is then a config change once
the clause is in the signed terms.

Do not display a due date while nothing happens on that date. A deadline with no
consequence teaches clients the deadline is decoration, and it stays decoration
at scale.

---

## 8. Contract clauses the software depends on

The terms document is the real specification. Each item below is a clause the
code assumes exists:

1. **Self-billing authorisation** — platform issues invoices in the freelancer's
   name from approved hours; freelancer's right to object and the correction path.
2. **Approval window** — length, and whether silence constitutes approval.
3. **Rejection procedure** — what a rejection obliges, and by when.
4. **Payment timing, both legs** — when the client pays the platform, when the
   platform pays the freelancer, and *whether the second depends on the first*.
   This determines working capital exposure and is currently unanswered.
5. **Additional charges** — pre-agreement requirement, cap, receipt obligation,
   and explicit exclusion of overtime and premium rates if they're out of scope.
6. **Wet DBA clauses** — no gezag, no fixed hours, freelancer sets working method.
7. **Termination and notice** — effect on an in-flight period.
8. **Rate change and extension** — new assignment or amendment.
9. **VAT treatment of the €2/hour deduction** — accountant's answer, then the
   invoice template follows it.

---

## 9. Build sequence

1. Data model, audit log, magic-link auth, admin panel access.
2. F2 entry grid and submit. (First demonstrable end of the loop.)
3. C1 approve/reject with versioning.
4. Invoice generation, both directions, PDF.
5. The seven emails.
6. Additional charges.

Steps 1–5 are shippable. Charges can land in month two — placement #1's first
possible expense claim arrives at the earliest end of month one.

---

## 10. Open items

- Which side pays the per-assignment fixed fee (€250–500), and when is it charged.
- VAT treatment of the freelancer-side deduction.
- Payout timing versus client payment terms (see §8.4).
- Expense cap and receipt retention obligations.
- Partial months: mid-month start, mid-month end.
- Hour rounding: decimal, quarter, or half.
- Language: UI English or Dutch; invoices likely Dutch regardless.
