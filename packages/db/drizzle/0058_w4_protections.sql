-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Overhaul wave 4 protections (AGENTS.md rule 9), in addition to the earlier protection files:
--   1. `users.first_notify_optin_at` (from wave 2: `notify_optin` counts first opt-ins exactly) is
--      written only by these triggers: a `notification_preferences` row turned on for email or push
--      (an insert dates from its UUIDv7 id, as the metric did before; an update that turns a row on
--      dates from now), or a `push_subscriptions` row (its `created_at`). It is never cleared and
--      never moves later; an earlier opt-in written afterwards (a backdated seed) moves it earlier.
--   2. `moderation_cases.assignee_id` (D7.5) names a moderator, admin or legal user, and
--      `assigned_at` is set exactly when it is.

-- 1. First notification opt-in -------------------------------------------------------------------

CREATE OR REPLACE FUNCTION w4_uuidv7_time(id uuid) RETURNS timestamptz
LANGUAGE sql IMMUTABLE AS $$
  SELECT to_timestamp(('x' || left(replace(id::text, '-', ''), 12))::bit(48)::bigint / 1000.0)
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION w4_record_notify_optin(p_user uuid, p_at timestamptz) RETURNS void
LANGUAGE sql AS $$
  UPDATE users SET first_notify_optin_at = p_at
   WHERE id = p_user AND (first_notify_optin_at IS NULL OR first_notify_optin_at > p_at)
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION w4_notify_pref_optin() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.enabled AND NEW.medium IN ('email', 'push') THEN
    IF TG_OP = 'INSERT' THEN
      PERFORM w4_record_notify_optin(NEW.user_id, least(w4_uuidv7_time(NEW.id), now()));
    ELSIF NOT OLD.enabled OR OLD.medium NOT IN ('email', 'push') THEN
      PERFORM w4_record_notify_optin(NEW.user_id, now());
    END IF;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint

CREATE TRIGGER notification_preferences_first_optin
  AFTER INSERT OR UPDATE OF enabled, medium ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION w4_notify_pref_optin();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION w4_push_sub_optin() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM w4_record_notify_optin(NEW.user_id, NEW.created_at);
  RETURN NULL;
END $$;
--> statement-breakpoint

CREATE TRIGGER push_subscriptions_first_optin
  AFTER INSERT ON push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION w4_push_sub_optin();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION w4_first_optin_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.first_notify_optin_at IS NOT NULL AND
     (NEW.first_notify_optin_at IS NULL OR NEW.first_notify_optin_at > OLD.first_notify_optin_at) THEN
    RAISE EXCEPTION 'users.first_notify_optin_at is never cleared or moved later'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER users_first_optin_guard
  BEFORE UPDATE OF first_notify_optin_at ON users
  FOR EACH ROW EXECUTE FUNCTION w4_first_optin_guard();
--> statement-breakpoint

-- Backfill from the rows that exist (the same rule the nightly metric used).
UPDATE users u SET first_notify_optin_at = f.first_at
  FROM (
    SELECT x.user_id, min(x.at) AS first_at FROM (
      SELECT user_id, least(w4_uuidv7_time(id), now()) AS at
        FROM notification_preferences WHERE enabled AND medium IN ('email', 'push')
      UNION ALL
      SELECT user_id, created_at AS at FROM push_subscriptions
    ) x GROUP BY x.user_id
  ) f
 WHERE u.id = f.user_id;
--> statement-breakpoint

-- 2. Case assignment -------------------------------------------------------------------------------

ALTER TABLE moderation_cases ADD CONSTRAINT moderation_cases_assigned_at_set
  CHECK ((assignee_id IS NULL) = (assigned_at IS NULL));
--> statement-breakpoint

CREATE OR REPLACE FUNCTION w4_case_assignee_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assignee_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users WHERE id = NEW.assignee_id AND role IN ('moderator', 'admin', 'legal')
  ) THEN
    RAISE EXCEPTION 'moderation_cases.assignee_id must be a moderator, admin or legal user'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER moderation_cases_assignee_guard
  BEFORE INSERT OR UPDATE OF assignee_id ON moderation_cases
  FOR EACH ROW EXECUTE FUNCTION w4_case_assignee_guard();
