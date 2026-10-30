-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- N1 protections (ADR 0028), in addition to 0034:
--   1. The notifications.goLive governance setting is shape- and range-checked with the same
--      bounds as GoLiveSetting in @commonair/contracts: a decision can lengthen or shorten the
--      cooldown but never below one hour, so no vote turns go-live into a flood.
-- The new tables need no grant changes: commonair_configure_app_role (0034) grants DML on every
-- table and the migrate job re-runs it; nothing in them is append-only.

-- 1. notifications.goLive is shape- and range-checked. -------------------------------------
CREATE FUNCTION commonair_validate_notifications_go_live() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb := NEW.value;
BEGIN
  IF jsonb_typeof(v->'cooldownHours') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v->'emailDigestMinutes') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'notifications.goLive needs numeric cooldownHours and emailDigestMinutes'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (v->>'cooldownHours')::numeric NOT BETWEEN 1 AND 48
     OR (v->>'emailDigestMinutes')::numeric NOT BETWEEN 0 AND 60
     OR (v->>'cooldownHours')::numeric <> trunc((v->>'cooldownHours')::numeric)
     OR (v->>'emailDigestMinutes')::numeric <> trunc((v->>'emailDigestMinutes')::numeric) THEN
    RAISE EXCEPTION 'notifications.goLive values out of range' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER governance_settings_notifications_go_live_ck BEFORE INSERT OR UPDATE ON public.governance_settings
  FOR EACH ROW WHEN (NEW.key = 'notifications.goLive') EXECUTE FUNCTION commonair_validate_notifications_go_live();
