-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Follow-ups, unit money: card share chargebacks (ADR 0020, ADR 0007), in addition to 0021 and
-- 0049, against a caller with ordinary DML on every table who does not own them (AGENTS.md
-- rule 9). A dispute on a card share's payment claws the share capital back when it opens
-- (`share_chargeback`, Dr member share, Cr cash), and a won dispute restores it
-- (`share_chargeback_reversal`). A share is "charged back" while it has more chargebacks than
-- reversals.
--   1. Ledger: a `share_chargeback` posting is keyed `share-chargeback:<disputes.id>` for a
--      chargeback row of the share's own payment, references the share (`membership_share`), and
--      is posted only while the share is held or refund_pending and not already charged back. A
--      `share_chargeback_reversal` is keyed `share-chargeback-reversal:<disputes.id>` and needs that
--      dispute's chargeback posted for the same share, on a share still held or refund_pending
--      (a lost dispute cancelled it for good). A `share_refund` posting is refused while the share
--      is charged back, and a share whose refund is posted is never charged back.
--   2. membership_shares (commonair_share_guard, redefined from 0021): a charged-back share is
--      never refunded (refund_pending -> refunded needs no outstanding chargeback, so the member
--      is never paid back twice), and held | refund_pending -> cancelled is allowed only while it
--      is charged back (a lost dispute ends the share and frees the member's one open share).
--      Everything else is unchanged.
-- Functions pin search_path and schema-qualify tables (ADR 0004).

-- 1. Ledger ---------------------------------------------------------------------------------
CREATE FUNCTION commonair_share_chargebacks_outstanding(share_id uuid) RETURNS bigint
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT count(*) FILTER (WHERE t.kind = 'share_chargeback')
       - count(*) FILTER (WHERE t.kind = 'share_chargeback_reversal')
    FROM public.ledger_transactions t
   WHERE t.ref_type = 'membership_share' AND t.ref_id = share_id
     AND t.kind IN ('share_chargeback', 'share_chargeback_reversal')
$$;
--> statement-breakpoint
CREATE FUNCTION commonair_share_chargeback_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  sh record;
  dispute_ref text;
BEGIN
  IF NEW.ref_type IS DISTINCT FROM 'membership_share' OR NEW.ref_id IS NULL THEN
    RAISE EXCEPTION 'a share chargeback posting references its member share' USING ERRCODE = 'check_violation';
  END IF;
  -- Lock the share before reading it: a refund or another dispute of the same share committing
  -- meanwhile is then seen here (a status read before the lock could be stale).
  SELECT m.id, m.status::text AS status, m.payment_id INTO sh FROM public.membership_shares m
   WHERE m.id = NEW.ref_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such member share' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.kind = 'share_chargeback' THEN
    IF NEW.idempotency_key !~ '^share-chargeback:[0-9a-f-]{36}$' THEN
      RAISE EXCEPTION 'a share chargeback is keyed by its dispute' USING ERRCODE = 'check_violation';
    END IF;
    dispute_ref := substr(NEW.idempotency_key, length('share-chargeback:') + 1);
    IF NOT EXISTS (SELECT 1 FROM public.disputes d
                    WHERE d.id::text = dispute_ref AND d.kind = 'chargeback' AND d.payment_id = sh.payment_id) THEN
      RAISE EXCEPTION 'a share chargeback needs a chargeback of the share''s own payment' USING ERRCODE = 'check_violation';
    END IF;
    IF sh.status NOT IN ('held', 'refund_pending') THEN
      RAISE EXCEPTION 'only a held or refund_pending share is charged back (this one is %)', sh.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF public.commonair_share_chargebacks_outstanding(sh.id) > 0 THEN
      RAISE EXCEPTION 'this share is already charged back' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.ledger_transactions t WHERE t.idempotency_key = 'share-refund:' || sh.id::text) THEN
      RAISE EXCEPTION 'a refunded share is never charged back' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.idempotency_key !~ '^share-chargeback-reversal:[0-9a-f-]{36}$' THEN
      RAISE EXCEPTION 'a share chargeback reversal is keyed by its dispute' USING ERRCODE = 'check_violation';
    END IF;
    dispute_ref := substr(NEW.idempotency_key, length('share-chargeback-reversal:') + 1);
    IF NOT EXISTS (SELECT 1 FROM public.ledger_transactions t
                    WHERE t.idempotency_key = 'share-chargeback:' || dispute_ref
                      AND t.kind = 'share_chargeback' AND t.ref_id = sh.id) THEN
      RAISE EXCEPTION 'a share chargeback reversal needs that dispute''s chargeback' USING ERRCODE = 'check_violation';
    END IF;
    -- A lost dispute cancelled the share: nothing gives its capital back any more.
    IF sh.status NOT IN ('held', 'refund_pending') THEN
      RAISE EXCEPTION 'only a held or refund_pending share''s chargeback is reversed (this one is %)', sh.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_share_chargeback BEFORE INSERT ON public.ledger_transactions
  FOR EACH ROW WHEN (NEW.kind IN ('share_chargeback', 'share_chargeback_reversal'))
  EXECUTE FUNCTION commonair_share_chargeback_guard();
--> statement-breakpoint
-- A share refund posting while a chargeback stands would pay the member back twice (the
-- processor already returned the money). Keyed `share-refund:<share id>` (0021's guard reads
-- that key), so the share is found from the key whatever the posting references.
CREATE FUNCTION commonair_share_refund_posting_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  share_ref text;
BEGIN
  IF NEW.idempotency_key !~* '^share-refund:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NEW;
  END IF;
  share_ref := substr(NEW.idempotency_key, length('share-refund:') + 1);
  -- The share row lock orders this against a chargeback of the same share.
  PERFORM 1 FROM public.membership_shares m WHERE m.id = share_ref::uuid FOR UPDATE;
  IF FOUND AND public.commonair_share_chargebacks_outstanding(share_ref::uuid) > 0 THEN
    RAISE EXCEPTION 'a charged-back share is never refunded' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_share_refund_posting BEFORE INSERT ON public.ledger_transactions
  FOR EACH ROW WHEN (NEW.kind = 'share_refund')
  EXECUTE FUNCTION commonair_share_refund_posting_guard();
--> statement-breakpoint

-- 2. Member shares (0021's guard, plus the chargeback rules) ---------------------------------
CREATE OR REPLACE FUNCTION commonair_share_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'member shares are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status::text <> 'pending' OR NEW.purchased_at IS NOT NULL OR NEW.refunded_at IS NOT NULL THEN
      RAISE EXCEPTION 'a member share starts pending' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.amount_cents <= 0 OR NEW.currency !~ '^[a-z]{3}$' THEN
      RAISE EXCEPTION 'a member share needs a positive amount and a currency' USING ERRCODE = 'check_violation';
    END IF;
    -- One open share per user. The unique index covers pending/held; refund_pending is checked
    -- here, serialized per user so two concurrent inserts cannot both pass.
    PERFORM pg_advisory_xact_lock(hashtext('commonair:share:' || NEW.user_id::text));
    IF EXISTS (SELECT 1 FROM public.membership_shares m
                WHERE m.user_id = NEW.user_id AND m.status::text IN ('pending', 'held', 'refund_pending')) THEN
      RAISE EXCEPTION 'this member already has an open share' USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.amount_cents <> OLD.amount_cents
     OR NEW.currency <> OLD.currency OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a member share''s user, amount, currency and payment never change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.purchased_at IS DISTINCT FROM OLD.purchased_at OR NEW.refunded_at IS DISTINCT FROM OLD.refunded_at THEN
      RAISE EXCEPTION 'share dates change only with a status transition' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status::text = 'pending' AND NEW.status::text = 'held' THEN
    IF NEW.purchased_at IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.payments p WHERE p.id = NEW.payment_id AND p.status = 'succeeded'
                        AND p.kind = 'membership_share' AND p.amount_cents = NEW.amount_cents)
       OR NOT EXISTS (SELECT 1 FROM public.ledger_transactions t
                       WHERE t.idempotency_key = 'share-purchase:' || NEW.id::text) THEN
      RAISE EXCEPTION 'a share is held only once its payment succeeded and the purchase is posted' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.status::text = 'pending' AND NEW.status::text = 'cancelled' THEN
    NULL;
  ELSIF OLD.status::text = 'held' AND NEW.status::text = 'refund_pending' THEN
    NULL;
  ELSIF OLD.status::text = 'refund_pending' AND NEW.status::text = 'refunded' THEN
    IF NEW.refunded_at IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.ledger_transactions t
                       WHERE t.idempotency_key = 'share-refund:' || NEW.id::text) THEN
      RAISE EXCEPTION 'a share is refunded only once the refund is posted' USING ERRCODE = 'check_violation';
    END IF;
    IF public.commonair_share_chargebacks_outstanding(NEW.id) > 0 THEN
      RAISE EXCEPTION 'a charged-back share is never refunded' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.status::text IN ('held', 'refund_pending') AND NEW.status::text = 'cancelled' THEN
    IF public.commonair_share_chargebacks_outstanding(NEW.id) <= 0 THEN
      RAISE EXCEPTION 'a paid share is cancelled only by a chargeback' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'a member share cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.purchased_at IS DISTINCT FROM OLD.purchased_at AND NOT (OLD.status::text = 'pending' AND NEW.status::text = 'held') THEN
    RAISE EXCEPTION 'purchased_at is set only when the share becomes held' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.refunded_at IS DISTINCT FROM OLD.refunded_at AND NOT (NEW.status::text = 'refunded') THEN
    RAISE EXCEPTION 'refunded_at is set only when the share is refunded' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
