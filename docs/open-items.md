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

**ANSWERED.** Every rate is ex VAT — the client's €100, the freelancer's €95,
and the €2 deduction.

That the €2 is *ex VAT* settles more than the number. A discount on someone's
rate carries no VAT of its own; a €2 that has 21% added to it is a **taxable
supply from the platform to the freelancer** — an intermediation service they
buy, and whose VAT they reclaim. So there are two supplies, not one netted
amount:

| | Ex VAT | VAT 21% | Incl. |
|---|---|---|---|
| Freelancer → platform (self-billed) | 95.00 | 19.95 | 114.95 |
| Platform → freelancer (the fee) | 2.00 | 0.42 | 2.42 |
| **Cash to the freelancer** | | | **112.53** |

€93.00/hour is still what the freelancer keeps once VAT settles through their
return. It is not what arrives in the bank, and the confirmation screen now
shows both.

**Implemented in:** `computeFees()` in `src/domain/money.js`, which returns
ex-VAT, VAT and inclusive figures per supply plus `freelancer_cash`. Tested
under "VAT — spec §8.9, answered". VAT is applied once to the line total, not
per hour and multiplied, with a test that the two agree at awkward hour counts.

**Still open, and it is the part that blocks step 4:** *one document or two?*

Spec §3 says the fee is "deducted on the self-billed invoice". A self-billed
invoice is the **freelancer's sales invoice**, issued in their name. Putting
the platform's own fee on it as a negative line reduces their stated turnover
by €2/hour, which is wrong if the fee is a separate supply — and "ex VAT" says
it is. The consistent treatment is two documents, netted in payment:

1. a self-billed invoice, freelancer → platform, €95/hour + VAT;
2. an invoice from the platform → freelancer, €2/hour + VAT.

That is the strong default and what the arithmetic now assumes, but it is a
question for the accountant and not one to settle from a code comment. It
determines the invoice templates, so answer it before step 4 starts.

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
**Invoices will be Dutch regardless** — nothing in `src/i18n/` is used for
invoice output, and step 4 should not reuse it.

### 8. Approval window and whether silence constitutes approval (§7)

**Default:** reminder only, auto-approve off.
`approval_window_days` is set (5) and `auto_approve_enabled` is `false`.
The due date is computed and carried on the period view but **not displayed**,
because nothing happens on that date yet. `due_date_is_binding` gates the UI on
`auto_approve_enabled`, so enabling the clause turns the date on with it.
**Change in:** one boolean, once the clause is in the signed terms.

### 9. Self-billing, rejection procedure, termination, rate change (§8)

**Default:** the code assumes the clauses exist as §8 describes them. The
rejection path is built as: reject → the decided version is frozen → a
pre-filled successor is created. If the signed terms describe a different
correction path, this is the part that changes.

---

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
