-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Batch 8 protections (M1; .claude/briefs/b8/contract-step.md §2.2, ADR 0007 Amendment 1), in
-- addition to 0001, 0016, 0021, 0025, 0029, 0034, 0038, 0043, 0046 and 0047, against a caller with
-- ordinary DML on every table who does not own them (AGENTS.md rule 9):
--   1. Gifts (decision (d)): one pending gift payment per gifter and channel (a partial unique
--      index; the API's CONFLICT is in addition to it). `payments.gift` is set at insert, only on a
--      subscription payment with a gifter and a channel, and never changes. A subscription names a
--      payment in `gift_payment_id` only if that payment is a gift, so the index cannot be dodged
--      by an unflagged payment.
--   2. Connect transfers (decision (f)): a `payout_transfers` row is inserted `pending`, with no
--      provider reference, reversal or failure code, for a `scheduled` Stripe payout, for exactly
--      the payout's amount and currency, to the payee's own Stripe payout account. Afterwards only
--      `pending -> created | failed` and `created -> reversed` move the status; `created` needs the
--      provider reference, `reversed` needs every cent reversed; `reversed_cents` only rises and
--      only on a created transfer; the provider reference is set once; the failure code changes
--      only while pending; everything else is frozen. `pending -> created` needs the payout still
--      `scheduled` (under its row lock). Rows are never deleted or truncated.
--      Under a transfer, the payout is frozen too: its payee, provider, amount and currency never
--      change, and its status follows the transfer's (pending: only among pending, scheduled and
--      held, so fraud holds still work; created or reversed: only scheduled -> paid; `failed` only
--      once the transfer failed; `paid` only once it was created). So a payout is never both paid
--      by a transfer and cancelled back to the payable. Writers update the transfer first, then
--      the payout, in one transaction.
--   3. Patronage payouts (ADR 0020): a row is inserted `pending`, unpaid, for an approved (or
--      distributed) period, in its currency, for a member with an allocation of at least the
--      amount. `pending -> paid | failed` and `paid -> reversed` only; `paid` needs a reference and
--      a time, each set once and only while pending; the provider changes only while pending; the
--      paid rows of a member for a period never sum above their allocation (checked under the
--      allocation's row lock). A `failed` or `reversed` row is followed by a new one (0048's unique
--      index covers only pending and paid rows). Rows are never deleted or truncated.
--   4. Governance: `shares.cardPayments` is shape-checked like `SharesCardPaymentsSetting` in
--      @commonair/contracts (seeded false by @commonair/db's seed).
--   5. commonair_configure_app_role: the app loses DELETE on both new tables (redefined from 0046's
--      version; the migrate job re-runs it after every migration).
-- The ledger needs nothing new: the reversal posting kinds balance under 0001's trigger and their
-- idempotency keys are unique like every other posting's.
-- Functions pin search_path and schema-qualify tables (ADR 0004).

-- 1. Gifts --------------------------------------------------------------------------------
ALTER TABLE public.payments ADD CONSTRAINT payments_gift_is_subscription CHECK (NOT gift OR kind = 'subscription');
--> statement-breakpoint
CREATE UNIQUE INDEX payments_open_gift_uq ON public.payments USING btree (user_id, channel_id)
  WHERE gift AND status = 'pending';
--> statement-breakpoint
CREATE FUNCTION commonair_payments_gift_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The index treats NULLs as distinct; a CHECK would break account deletion (ON DELETE SET NULL).
    IF NEW.gift AND (NEW.user_id IS NULL OR NEW.channel_id IS NULL) THEN
      RAISE EXCEPTION 'a gift payment has a gifter and a channel' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.gift IS DISTINCT FROM OLD.gift THEN
    RAISE EXCEPTION 'a payment''s gift flag never changes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payments_gift_frozen BEFORE INSERT OR UPDATE OF gift ON public.payments
  FOR EACH ROW EXECUTE FUNCTION commonair_payments_gift_frozen();
--> statement-breakpoint
CREATE FUNCTION commonair_subscriptions_gift_payment() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.gift_payment_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.gift_payment_id IS DISTINCT FROM OLD.gift_payment_id)
     AND NOT EXISTS (SELECT 1 FROM public.payments p WHERE p.id = NEW.gift_payment_id AND p.gift) THEN
    RAISE EXCEPTION 'a subscription''s gift payment is a gift payment' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER subscriptions_gift_payment_ck BEFORE INSERT OR UPDATE OF gift_payment_id ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION commonair_subscriptions_gift_payment();
--> statement-breakpoint

-- 2. Connect transfers --------------------------------------------------------------------
CREATE FUNCTION commonair_payout_transfers_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  po record;
  acct record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payout transfers are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.provider_ref IS NOT NULL OR NEW.reversed_cents <> 0
       OR NEW.failure_code IS NOT NULL THEN
      RAISE EXCEPTION 'a payout transfer starts pending, with no provider reference, reversal or failure'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Held until commit, so the payout cannot leave `scheduled` under a transfer being written.
    SELECT p.user_id, p.provider, p.status, p.amount_cents, p.currency INTO po
      FROM public.payouts p WHERE p.id = NEW.payout_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such payout' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF po.provider <> 'stripe' OR NEW.provider <> 'stripe' THEN
      RAISE EXCEPTION 'only a Stripe payout is paid by a Connect transfer' USING ERRCODE = 'check_violation';
    END IF;
    IF po.status <> 'scheduled' THEN
      RAISE EXCEPTION 'a transfer needs a scheduled payout (this one is %)', po.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.amount_cents <> po.amount_cents OR NEW.currency <> po.currency THEN
      RAISE EXCEPTION 'a transfer moves exactly its payout''s amount and currency' USING ERRCODE = 'check_violation';
    END IF;
    SELECT a.provider, a.provider_account_id INTO acct FROM public.payout_accounts a WHERE a.user_id = po.user_id;
    IF NOT FOUND OR acct.provider <> 'stripe' OR acct.provider_account_id IS DISTINCT FROM NEW.destination_ref THEN
      RAISE EXCEPTION 'a transfer goes only to the payee''s own Stripe payout account' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- Held until commit, and taken before the payout's own update in the same transaction, so a
    -- payout update elsewhere waits for this one and then sees the new transfer status (see
    -- commonair_payouts_transfer_guard), or this one waits and sees the new payout status.
    SELECT p.status INTO po FROM public.payouts p WHERE p.id = OLD.payout_id FOR SHARE;
    IF OLD.status = 'pending' AND NEW.status = 'created' AND po.status IS DISTINCT FROM 'scheduled' THEN
      RAISE EXCEPTION 'a transfer is recorded only for a scheduled payout (this one is %)', po.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.payout_id IS DISTINCT FROM OLD.payout_id
     OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.destination_ref IS DISTINCT FROM OLD.destination_ref
     OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a payout transfer''s payout, destination, amount and key never change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('created', 'failed'))
       OR (OLD.status = 'created' AND NEW.status = 'reversed')) THEN
    RAISE EXCEPTION 'a payout transfer cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref THEN
    RAISE EXCEPTION 'a transfer''s provider reference is set once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IN ('created', 'reversed') AND NEW.provider_ref IS NULL THEN
    RAISE EXCEPTION 'a created transfer has its provider reference' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reversed_cents < OLD.reversed_cents THEN
    RAISE EXCEPTION 'reversed_cents only rises' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reversed_cents > OLD.reversed_cents AND NEW.status NOT IN ('created', 'reversed') THEN
    RAISE EXCEPTION 'only a created transfer is reversed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'reversed' AND NEW.reversed_cents <> NEW.amount_cents THEN
    RAISE EXCEPTION 'a transfer is reversed only once every cent is' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.failure_code IS DISTINCT FROM OLD.failure_code AND OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a transfer''s failure code changes only while it is pending' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payout_transfers_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payout_transfers
  FOR EACH ROW EXECUTE FUNCTION commonair_payout_transfers_guard();
--> statement-breakpoint
CREATE TRIGGER payout_transfers_no_truncate BEFORE TRUNCATE ON public.payout_transfers
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
-- The payout under a transfer. The transfer is read, not locked: its writers lock the payout
-- first (above), so whichever commits second sees the other's change on its fresh snapshot.
CREATE FUNCTION commonair_payouts_transfer_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  tr_status text;
BEGIN
  SELECT t.status::text INTO tr_status FROM public.payout_transfers t WHERE t.payout_id = OLD.id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'a payout''s payee, provider, amount and currency never change under its transfer'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF (tr_status = 'pending' AND NEW.status::text NOT IN ('pending', 'scheduled', 'held'))
     OR (tr_status IN ('created', 'reversed') AND NOT (OLD.status::text = 'scheduled' AND NEW.status::text = 'paid'))
     OR (NEW.status::text = 'paid' AND tr_status <> 'created')
     OR (NEW.status::text = 'failed' AND tr_status <> 'failed') THEN
    RAISE EXCEPTION 'a payout cannot go from % to % while its transfer is %', OLD.status, NEW.status, tr_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payouts_transfer_guard BEFORE UPDATE ON public.payouts
  FOR EACH ROW EXECUTE FUNCTION commonair_payouts_transfer_guard();
--> statement-breakpoint

-- 3. Patronage payouts --------------------------------------------------------------------
CREATE FUNCTION commonair_patronage_payouts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  per record;
  allocated bigint;
  paid bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'patronage payouts are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.provider_ref IS NOT NULL OR NEW.paid_at IS NOT NULL THEN
      RAISE EXCEPTION 'a patronage payout starts pending and unpaid' USING ERRCODE = 'check_violation';
    END IF;
    SELECT pp.status, pp.currency INTO per FROM public.patronage_periods pp WHERE pp.id = NEW.period_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such patronage period' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF per.status NOT IN ('approved', 'distributed') THEN
      RAISE EXCEPTION 'only an approved patronage period is paid out (this one is %)', per.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.currency <> per.currency THEN
      RAISE EXCEPTION 'a patronage payout is in its period''s currency' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.period_id IS DISTINCT FROM OLD.period_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
       OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'a patronage payout''s period, member, amount and key never change' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'pending' AND NEW.status IN ('paid', 'failed'))
         OR (OLD.status = 'paid' AND NEW.status = 'reversed')) THEN
      RAISE EXCEPTION 'a patronage payout cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.provider IS DISTINCT FROM OLD.provider AND (OLD.status <> 'pending' OR NEW.status <> 'pending') THEN
      RAISE EXCEPTION 'a patronage payout''s provider changes only while it is pending' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref THEN
      RAISE EXCEPTION 'a patronage payout''s reference is set once' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.paid_at IS NOT NULL AND NEW.paid_at IS DISTINCT FROM OLD.paid_at THEN
      RAISE EXCEPTION 'a patronage payout''s paid time is set once' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status <> 'pending' AND (NEW.provider_ref IS DISTINCT FROM OLD.provider_ref
                                    OR NEW.paid_at IS DISTINCT FROM OLD.paid_at) THEN
      RAISE EXCEPTION 'a patronage payout''s reference and paid time are set only while it is pending'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IN ('paid', 'reversed') AND (NEW.provider_ref IS NULL OR NEW.paid_at IS NULL) THEN
      RAISE EXCEPTION 'a paid patronage payout has its reference and time' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- The allocation's row lock serializes every writer of this member's payouts for the period.
  SELECT a.amount_cents INTO allocated FROM public.patronage_allocations a
   WHERE a.period_id = NEW.period_id AND a.user_id = NEW.user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a patronage payout needs the member''s allocation for the period' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount_cents > allocated THEN
    RAISE EXCEPTION 'a patronage payout never exceeds the allocation' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'paid' THEN
    SELECT coalesce(sum(p.amount_cents), 0) INTO paid FROM public.patronage_payouts p
     WHERE p.period_id = NEW.period_id AND p.user_id = NEW.user_id AND p.status = 'paid' AND p.id <> NEW.id;
    IF paid + NEW.amount_cents > allocated THEN
      RAISE EXCEPTION 'paid patronage never exceeds the allocation' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER patronage_payouts_guard BEFORE INSERT OR UPDATE OR DELETE ON public.patronage_payouts
  FOR EACH ROW EXECUTE FUNCTION commonair_patronage_payouts_guard();
--> statement-breakpoint
CREATE TRIGGER patronage_payouts_no_truncate BEFORE TRUNCATE ON public.patronage_payouts
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 4. Governance: shares.cardPayments ------------------------------------------------------
CREATE FUNCTION commonair_validate_shares_setting() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.key = 'shares.cardPayments' AND jsonb_typeof(NEW.value->'enabled') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'shares.cardPayments needs a boolean enabled' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER governance_settings_shares_ck BEFORE INSERT OR UPDATE ON public.governance_settings
  FOR EACH ROW WHEN (NEW.key = 'shares.cardPayments')
  EXECUTE FUNCTION commonair_validate_shares_setting();
--> statement-breakpoint

-- 5. App role (additions only to 0046's version) ------------------------------------------
CREATE OR REPLACE FUNCTION commonair_configure_app_role(r name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r);
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', r);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', r);
  EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM %I', r);
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.governance_settings_history, public.governance_applications,
    public.vote_history, public.membership_history, public.proposal_electorate FROM %I', r);
  EXECUTE format('REVOKE INSERT, DELETE ON public.governance_settings FROM %I', r);
  EXECUTE format('REVOKE UPDATE, DELETE ON public.ledger_transactions, public.ledger_entries, public.audit_log FROM %I', r);
  EXECUTE format('REVOKE DELETE ON public.ledger_accounts, public.votes, public.memberships FROM %I', r);
  -- Trust & safety (0016): evidence and flags are append-only; holds, drafts, cases, labels,
  -- the local block list and undecided NCII requests are never deleted by the app.
  EXECUTE format('REVOKE UPDATE, DELETE ON public.moderation_flags, public.evidence_objects FROM %I', r);
  EXECUTE format('REVOKE DELETE ON public.legal_holds, public.ncmec_reports, public.moderation_cases,
    public.content_labels, public.local_hash_list FROM %I', r);
  -- Co-op (0021): tallies, council terms, seats and responses are append-only; shares are never deleted.
  EXECUTE format('REVOKE UPDATE, DELETE ON public.tallies, public.council_terms, public.council_members,
    public.council_responses FROM %I', r);
  EXECUTE format('REVOKE DELETE ON public.membership_shares FROM %I', r);
  -- E7 (0025): account actions and DMCA records are never deleted by the app.
  EXECUTE format('REVOKE DELETE ON public.account_actions, public.dmca_notices, public.dmca_counter_notices, public.dmca_notice_items FROM %I', r);
  -- W0 (0029): statements of reasons are append-only.
  EXECUTE format('REVOKE UPDATE, DELETE ON public.enforcement_statements FROM %I', r);
  -- E8 (0034): points are a ledger; balances are trigger-written.
  EXECUTE format('REVOKE UPDATE, DELETE ON public.loyalty_transactions FROM %I', r);
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.loyalty_balances FROM %I', r);
  -- W1 (0038): fraud flags are never deleted.
  EXECUTE format('REVOKE DELETE, TRUNCATE ON public.payment_fraud_flags FROM %I', r);
  -- W2 (0043): attestations, split links and answers are append-only; split versions, write-offs
  -- and signing keys are never deleted.
  EXECUTE format('REVOKE UPDATE, DELETE ON public.integrity_attestations, public.revenue_split_postings,
    public.revenue_split_acceptances FROM %I', r);
  EXECUTE format('REVOKE DELETE ON public.integrity_signing_keys, public.revenue_splits,
    public.split_writeoff_proposals FROM %I', r);
  -- Batch 7 (0046): winners, jury votes and actor key history are append-only; giveaways, jury
  -- panels, cases and seats, and portability signing keys are never deleted by the app; purge
  -- rows never change. Sequences (`relay_purges.seq`) need USAGE for inserts.
  EXECUTE format('REVOKE UPDATE, DELETE ON public.giveaway_winners, public.jury_votes,
    public.federation_actor_keys FROM %I', r);
  EXECUTE format('REVOKE DELETE ON public.giveaways, public.jury_panels, public.jury_cases, public.jury_seats,
    public.portability_signing_keys FROM %I', r);
  EXECUTE format('REVOKE UPDATE ON public.relay_purges FROM %I', r);
  -- Batch 8 (0049): Connect transfers and patronage payouts are append-mostly, never deleted.
  EXECUTE format('REVOKE DELETE ON public.payout_transfers, public.patronage_payouts FROM %I', r);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', r);
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION commonair_configure_app_role(name) FROM PUBLIC;
