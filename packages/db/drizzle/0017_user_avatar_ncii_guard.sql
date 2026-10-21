-- Custom SQL migration file, put your code below! --
-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- A Better Auth before-update hook is not transaction-scoped, so avatar revocation must also
-- serialize at the row write itself against the NCII removal transaction.

CREATE FUNCTION commonair_user_avatar_ncii_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_upload_key text;
BEGIN
  IF NEW.image IS NULL OR NEW.image IS NOT DISTINCT FROM OLD.image THEN
    RETURN NEW;
  END IF;

  -- The API stores canonical storage keys. The URL fallback covers rows written by older clients.
  IF NEW.image ~ '^channels/[0-9a-fA-F-]{36}/avatar/[A-Za-z0-9._/-]+$' THEN
    v_upload_key := NEW.image;
  ELSE
    v_upload_key := substring(NEW.image FROM '(channels/[0-9a-fA-F-]{36}/avatar/[A-Za-z0-9._/-]+)$');
  END IF;
  IF v_upload_key IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_upload_key, 0));
  IF EXISTS (
    SELECT 1 FROM public.ncii_request_items AS item
    WHERE item.upload_key = v_upload_key AND item.removed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'profile image is unavailable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER users_avatar_ncii_guard
  BEFORE INSERT OR UPDATE OF image ON public.users
  FOR EACH ROW EXECUTE FUNCTION commonair_user_avatar_ncii_guard();
