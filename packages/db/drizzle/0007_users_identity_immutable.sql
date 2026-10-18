-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Identity fields that gate age checks and account kinds are fixed after sign-up (AGENTS.md
-- rule 8: enforce at the lowest layer). The application role cannot change a birth date once
-- set, an account type, or a username; a minor cannot unlock 18+ content through any API bug.
--  * A birth date may be filled in once when it is still NULL (e.g. OAuth sign-up onboarding).
--  * Account pseudonymization (ADR 0004) may rewrite them: the update that sets
--    pseudonymized_at, and any update to a row already pseudonymized.
--  * The table owner (operators running migrations or a support runbook) is not restricted.

CREATE FUNCTION commonair_users_identity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.commonair_is_owner(TG_RELID) THEN
    RETURN NEW;
  END IF;
  IF OLD.pseudonymized_at IS NOT NULL
     OR (NEW.pseudonymized_at IS NOT NULL AND OLD.pseudonymized_at IS NULL) THEN
    RETURN NEW;
  END IF;
  IF OLD.birth_date IS NOT NULL AND NEW.birth_date IS DISTINCT FROM OLD.birth_date THEN
    RAISE EXCEPTION 'users.birth_date cannot be changed once set'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.account_type IS DISTINCT FROM OLD.account_type THEN
    RAISE EXCEPTION 'users.account_type cannot be changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.username IS DISTINCT FROM OLD.username THEN
    RAISE EXCEPTION 'users.username cannot be changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER users_identity_guard
  BEFORE UPDATE OF birth_date, account_type, username ON users
  FOR EACH ROW EXECUTE FUNCTION commonair_users_identity_guard();
