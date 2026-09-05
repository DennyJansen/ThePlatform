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

**Default:** unresolved, and deliberately not implemented. Every figure this
build shows is ex-VAT and labelled *excl. btw* / *excl. VAT*. `VAT_RATE_BP`
exists in `src/domain/money.js` at 21% and is used by nothing yet.
**Blocks:** step 4. Do not build the self-billed invoice template before the
accountant answers, or it gets built twice.

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
