# Open items

Spec §10 lists nine unanswered questions. Code cannot wait for all of them, so
each one has a **current default** below. A default is not an answer — it is
what the code does until someone decides, and where to change it when they do.

Nothing here is settled by having been implemented.

---

### 1. Which side pays the per-assignment fixed fee (€250–500), and when

**Default:** none. `assignments.fixed_fee_payer` is nullable and seeded `null`.
C2 shows the amount followed by *"betaler nog niet vastgelegd"* rather than
picking a side and displaying it as settled.
**Change in:** the column's check constraint already allows `'client'` or
`'freelancer'`; the label in `src/ui/screens/assignmentDetail.js` drops away
once the value is set. Billing it is step 4 work.

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

### 3. Payout timing versus client payment terms (spec §8.4)

**Default:** not modelled. `organizations.payment_terms_days` exists (30) for
the client leg. There is no field for the platform→freelancer leg, because
whether it *depends on* the first leg is precisely the unanswered question, and
a field would imply an answer.
**Note:** this determines working capital exposure. It is the most expensive
item on this list to get wrong and the cheapest to decide.

### 4. Expense cap and receipt retention obligations

**Default:** not enforced. `additional_charges` exists in the schema with
`receipt_file`; there is no cap and no retention rule.
**Change in:** step 6, which is when charges get a UI at all.

### 5. Partial months — mid-month start, mid-month end

**Default:** handled. `withinAssignment()` bounds every entry by the
assignment's `start_date`/`end_date`. Days outside the window render greyed and
non-enterable, and the domain refuses an entry on one even if it arrives
through a crafted payload.
**Still open:** whether a partial first month should be pro-rated for anything
other than hours — the fixed fee, for instance. See item 1.

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

### 8. Approval window and whether silence constitutes approval (§7)

**Default:** reminder only, auto-approve off.
`approval_window_days` is set (5) and `auto_approve_enabled` is `false`.
The due date is computed and carried on the period view but **not displayed**,
because nothing happens on that date yet. `due_date_is_binding` gates the UI on
`auto_approve_enabled`, so enabling the clause turns the date on with it.
**Change in:** one boolean, once the clause is in the signed terms.

### 9. Rejection procedure, termination, rate change (§8)

**Default:** the code assumes these clauses exist as §8 describes them.
**§8.1 (self-billing) is no longer among them** — see item 2b. The
rejection path is built as: reject → the decided version is frozen → a
pre-filled successor is created. If the signed terms describe a different
correction path, this is the part that changes.

---


## Added by sign-up and CV import

### CV retention and deletion

**Default: not decided, and currently not urgent.** Only the filename is
stored; the text is extracted in the browser and thrown away. That stops being
true the moment the file goes into Supabase Storage, and at that point
retention, deletion and access all need answers. See docs/compliance.md,
"A CV is personal data, and now you hold it".

### Company website enrichment

**Default: collected, not used.** The URL is stored on the organisation.
Nothing fetches it, because a browser cannot. The edge function that will is
sketched at the bottom of `src/data/enrichment.js`. Two things to decide before
writing it: whether to respect `robots.txt` (recommended — these are companies
you will have to talk to) and what to do when a site says nothing useful, which
will be most of them.

### Whether a company sign-up should be reviewed

**Default: no review.** Anyone with a valid-looking KvK number gets an account
and can post projects immediately, and a second person with the same KvK joins
automatically. That is right while the first placements are with companies you
know, and wrong the first time someone posts a project that should not be on
the board. There is no moderation queue and no report button.

### Whether joining an organisation should need approval

**Default: automatic.** The second person with a matching KvK is added to the
existing organisation without the first admin being asked. Convenient, and
exactly what you would not want if someone guessed a KvK number to see a
competitor's projects. KvK numbers are public.

---

## Not from §10, but decided in code and worth revisiting

**Session length.** 12 hours. Magic links: 24 hours, single use. Both are
constants at the top of `src/data/mock/mockAdapter.js`; under Supabase they
become project settings.

**Unsaved hours.** The F2 grid does not autosave. There is a *Concept opslaan*
button, an unsaved-changes indicator, and a browser warning before leaving with
pending edits. Autosave was not built because a draft that saves itself while
someone is mid-thought produces audit noise. If freelancers lose work anyway,
that reasoning was wrong and it should change.

**One approver, no delegation.** Spec §2, unchanged. The first holiday will
test it.
