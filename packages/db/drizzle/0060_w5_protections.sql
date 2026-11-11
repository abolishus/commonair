-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Overhaul wave 5 protections (AGENTS.md rule 9), in addition to the earlier protection files:
--   1. `channel_schedules.timezone` is an IANA name Postgres knows (`pg_timezone_names`).
--   2. A channel has at most 21 weekly slots and 100 one-offs (`SCHEDULE_RULES`); a one-off that
--      cancels a slot names a slot of the same channel.
--   3. `subscriptions.renewal_stopped_by_deletion_id` names a deletion of the subscriber or of the
--      channel's owner; it is cleared whenever `cancel_at_period_end` turns false.

-- 1. Schedule time zone ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION w5_schedule_timezone_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'channel_schedules.timezone must be a known IANA time zone'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER channel_schedules_timezone_guard
  BEFORE INSERT OR UPDATE OF timezone ON channel_schedules
  FOR EACH ROW EXECUTE FUNCTION w5_schedule_timezone_guard();
--> statement-breakpoint

-- 2. Schedule limits ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION w5_schedule_slots_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Serialize per channel so two concurrent inserts cannot both pass the count.
  PERFORM pg_advisory_xact_lock(hashtextextended('channel_schedule:' || NEW.channel_id::text, 0));
  IF (SELECT count(*) FROM channel_schedule_slots WHERE channel_id = NEW.channel_id) >= 21 THEN
    RAISE EXCEPTION 'a channel has at most 21 weekly schedule slots'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER channel_schedule_slots_limit
  BEFORE INSERT ON channel_schedule_slots
  FOR EACH ROW EXECUTE FUNCTION w5_schedule_slots_limit();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION w5_schedule_one_offs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('channel_schedule:' || NEW.channel_id::text, 0));
    IF (SELECT count(*) FROM channel_schedule_one_offs WHERE channel_id = NEW.channel_id) >= 100 THEN
      RAISE EXCEPTION 'a channel has at most 100 one-off schedule entries'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.cancels_slot_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM channel_schedule_slots WHERE id = NEW.cancels_slot_id AND channel_id = NEW.channel_id
  ) THEN
    RAISE EXCEPTION 'a cancelled occurrence must belong to a slot of the same channel'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER channel_schedule_one_offs_guard
  BEFORE INSERT OR UPDATE OF channel_id, cancels_slot_id ON channel_schedule_one_offs
  FOR EACH ROW EXECUTE FUNCTION w5_schedule_one_offs_guard();
--> statement-breakpoint

-- 3. Renewal stopped by a deletion ----------------------------------------------------------------

CREATE OR REPLACE FUNCTION w5_renewal_stop_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.renewal_stopped_by_deletion_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- Renewal turned back on (the member, the provider's webhook, or the cancelled deletion): the
  -- marker no longer describes the row, so it goes with it.
  IF NOT NEW.cancel_at_period_end THEN
    NEW.renewal_stopped_by_deletion_id := NULL;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM account_deletions d
     WHERE d.id = NEW.renewal_stopped_by_deletion_id
       AND (d.user_id = NEW.subscriber_id
            OR d.user_id = (SELECT owner_id FROM channels WHERE id = NEW.channel_id))
  ) THEN
    RAISE EXCEPTION 'subscriptions.renewal_stopped_by_deletion_id must be a deletion of the subscriber or the channel owner'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER subscriptions_renewal_stop_guard
  BEFORE INSERT OR UPDATE OF renewal_stopped_by_deletion_id, cancel_at_period_end ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION w5_renewal_stop_guard();
