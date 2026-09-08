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
rate carries no VAT of its own; a €2 that has 21% added to it is a **service
the freelancer buys**, and whose VAT they reclaim. So there are two amounts,
not one netted figure:

| | Ex VAT | VAT 21% | Incl. |
|---|---|---|---|
| The freelancer's hours | 95.00 | 19.95 | 114.95 |
| The platform's fee | 2.00 | 0.42 | 2.42 |
| **Net to the freelancer** | | | **112.53** |

€93.00/hour is still what the freelancer keeps once VAT settles through their
return. It is not the figure that moves, and the confirmation screen shows
both.

**Implemented in:** `computeFees()` in `src/domain/money.js`. Tested under
"VAT — spec §8.9, answered". VAT is applied once to the line total, not per
hour and multiplied, with a test that the two agree at awkward hour counts.

### 2b. Who raises the invoices — ANSWERED: not the platform

**Decided:** the freelancer and the company each raise their own invoices, in
their own systems. The platform generates no documents, allocates no invoice
numbers, and does not self-bill.

Three consequences worth having written down:

1. **Spec §8.1 stops being load-bearing.** The self-billing authorisation
   clause existed so the platform could invoice in the freelancer's name. It no
   longer does, so that clause can come out of the terms — and the invoice
   numbering problem it created (whose sequence does a self-billed invoice
   belong to?) disappears with it. That was the hardest unsolved item on this
   list an hour ago; this decision deletes it rather than answering it.
2. **§3's guarantee weakens, and that is the point of the system.** "The
   approved number and the invoiced number are the same number *by
   construction*" becomes "*…if whoever raises the invoice copies it
   correctly*". The platform still freezes, versions and audits the figure; the
   last step out to a document is now manual and invisible from here. That is
   the difference between a billing system and an approval tool, and it is a
   deliberate trade rather than an oversight.
3. **`invoiced` and `paid` stay** as period statuses, set by ops against
   documents raised elsewhere — which is what §1 already said about payment
   ("manual bank transfer, marked paid in admin").

**Removed:** `src/domain/invoice.js`, its tests, `004-invoices.sql`,
`CONFIG.platform`, and the invoice column on F3. Step 4 of §9 is struck.

### 2c. How the platform collects its own fee — OPEN

The one thing this decision leaves dangling, and it is commercial rather than
technical.

§3's model has the platform taking €5/hour as the spread between what the
client pays and what the freelancer gets, plus €2/hour from the freelancer.
Both assumed the platform sat in the middle of the invoice chain. If the
freelancer invoices the company directly, it does not:

- **The €5 spread has nowhere to live.** There is one rate on one invoice, and
  the freelancer is the one sending it. `client_rate_per_hour` and
  `freelancer_rate_per_hour` being two different numbers only means something
  if two different invoices exist.
- **The €2/hour still has to be billed by someone.** Presumably the platform
  invoices the freelancer for it — which is a platform-issued invoice, and so
  not quite "no invoicing via the platform".

Nothing is broken and nothing needs changing today: the code still implements
the §3 model, and the tests still hold it. But the board shows a freelancer
€95/hour while the company entered €100, and that €5 no longer has a mechanism
behind it. Worth deciding before the first real placement, because it changes
what the rate fields mean rather than just what they display.

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
