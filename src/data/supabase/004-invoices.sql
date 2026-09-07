-- =====================================================================
-- Migration 004 — the third invoice direction
-- Run after 003-signup.sql.
--
-- Spec §3 listed two directions on the assumption that the €2/hour deduction
-- was a line on the self-billed invoice. It is not. The fee is ex VAT, which
-- makes it a taxable supply from the platform to the freelancer, and a
-- self-billed invoice is the freelancer's OWN sales invoice — the platform's
-- fee on it as a negative line understates their turnover by €2 an hour.
--
-- So a settled month produces three documents, and two of them are netted
-- only when the money moves:
--
--   platform   -> client        hours x client rate      + VAT
--   freelancer -> platform      hours x freelancer rate  + VAT   (self-billed)
--   platform   -> freelancer    hours x fee              + VAT
--
-- See docs/open-items.md item 2.
-- =====================================================================

alter type invoice_direction add value if not exists 'platform_fee_to_freelancer';

-- The existing unique (period_id, direction) already allows three rows per
-- period, one per direction, and still prevents issuing the same document
-- twice for the same month.

-- ---------------------------------------------------------------------
-- Invoice numbers must be unique and gapless per issuer, and `number` is
-- already unique across the table. That is NOT sufficient once there are
-- three issuers sharing it — see docs/open-items.md, "Invoice numbering".
--
-- Recording the issuer makes the sequence a company can be audited on
-- visible, rather than something inferred from the direction later.
-- ---------------------------------------------------------------------
alter table invoices
  add column if not exists issuer_kvk text,
  add column if not exists seller_json jsonb,
  add column if not exists buyer_json  jsonb;

create index if not exists invoices_issuer_idx on invoices (issuer_kvk, issue_date);

-- Invoices are never rewritten. A mistake on a sent invoice is corrected with
-- a credit note, not an UPDATE — the same reason audit_events is append only,
-- and the same rule the Belastingdienst expects.
create rule invoice_no_delete as on delete to invoices do instead nothing;
