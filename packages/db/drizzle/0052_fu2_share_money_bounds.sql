-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Follow-ups, second pass (db-ledger review of 0051): bounds on what a card share's chargeback,
-- its reversal and a share refund post, against a caller with ordinary DML on every table who
-- does not own them (AGENTS.md rule 9). 0051 checked which postings may exist, not what they
-- move, and found a share's refund only by its canonical key:
--   1. A `share_chargeback` debits the share owner's member share by exactly its dispute's
--      amount, which is positive and never more than the share (`disputes` rows are app-writable;
--      the share's amount never changes, 0021/0051). No other member share line.
--   2. A `share_chargeback_reversal` credits that same member share by exactly what its
--      chargeback debited (the ledger is append-only, so a later edit of the dispute row changes
--      nothing). No other member share line.
--   3. A `share_refund` is keyed `share-refund:<id>` of an existing share, lower case (0021's
--      refunded transition and 0051's chargeback guard read that exact key). 0051 let any other
--      key through, so a refund posted while the share was charged back, or under an upper-case
--      key that a later chargeback did not see, paid the member back twice.
-- 1 and 2 run at commit (the entries follow the transaction row). Functions pin search_path and
-- schema-qualify tables (ADR 0004).

CREATE FUNCTION commonair_share_chargeback_amount_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  sh record;
  owner_code text;
  dispute_ref text;
  expected bigint;
  lines integer;
  owner_cents bigint;
BEGIN
  -- 0051's BEFORE guard admitted this row, so the share exists and the key names a dispute.
  SELECT m.user_id, m.currency, m.amount_cents INTO sh FROM public.membership_shares m WHERE m.id = NEW.ref_id;
  owner_code := 'liability:member-share:' || sh.user_id::text || '@' || sh.currency;
  SELECT count(*), sum(e.amount_cents) FILTER (WHERE a.code = owner_code) INTO lines, owner_cents
    FROM public.ledger_entries e JOIN public.ledger_accounts a ON a.id = e.account_id
   WHERE e.transaction_id = NEW.id AND a.code LIKE 'liability:member-share:%';
  IF NEW.kind = 'share_chargeback' THEN
    dispute_ref := substr(NEW.idempotency_key, length('share-chargeback:') + 1);
    SELECT d.amount_cents INTO expected FROM public.disputes d WHERE d.id::text = dispute_ref;
    IF lines <> 1 OR owner_cents IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'a share chargeback debits the owner''s member share by its dispute''s amount'
        USING ERRCODE = 'check_violation';
    END IF;
    IF owner_cents <= 0 OR owner_cents > sh.amount_cents THEN
      RAISE EXCEPTION 'a share chargeback never claws back more than the share (or nothing)'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    dispute_ref := substr(NEW.idempotency_key, length('share-chargeback-reversal:') + 1);
    SELECT sum(e.amount_cents) INTO expected
      FROM public.ledger_transactions t
      JOIN public.ledger_entries e ON e.transaction_id = t.id
      JOIN public.ledger_accounts a ON a.id = e.account_id
     WHERE t.idempotency_key = 'share-chargeback:' || dispute_ref AND a.code = owner_code;
    IF lines <> 1 OR expected IS NULL OR owner_cents IS DISTINCT FROM -expected THEN
      RAISE EXCEPTION 'a share chargeback reversal credits the member share by what its chargeback took'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_transactions_share_chargeback_amount AFTER INSERT ON public.ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.kind IN ('share_chargeback', 'share_chargeback_reversal'))
  EXECUTE FUNCTION commonair_share_chargeback_amount_check();
--> statement-breakpoint

-- 0051's guard, keyed strictly: the share is found from the key, whatever the posting references.
CREATE OR REPLACE FUNCTION commonair_share_refund_posting_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  share_ref text;
BEGIN
  IF NEW.idempotency_key !~ '^share-refund:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'a share refund is keyed share-refund:<its share id>' USING ERRCODE = 'check_violation';
  END IF;
  share_ref := substr(NEW.idempotency_key, length('share-refund:') + 1);
  -- The share row lock orders this against a chargeback of the same share.
  PERFORM 1 FROM public.membership_shares m WHERE m.id = share_ref::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a share refund is keyed share-refund:<its share id> (no such share)' USING ERRCODE = 'check_violation';
  END IF;
  IF public.commonair_share_chargebacks_outstanding(share_ref::uuid) > 0 THEN
    RAISE EXCEPTION 'a charged-back share is never refunded' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
