-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Social sign-in (Discord, Twitch, GitHub) only proves who the member is; nothing reads the
-- provider's tokens afterwards, so keeping them would only leave live third-party credentials in
-- the database (and its backups). better-auth still hands them to the adapter on every OAuth
-- sign-in and link: the API strips them in its account hooks, and this trigger discards them for
-- every role and write path, so they are never stored readable. Twitch import (ADR 0031) uses its
-- own one-shot token and does not need these.

CREATE FUNCTION commonair_discard_provider_tokens() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW.access_token := NULL;
  NEW.refresh_token := NULL;
  NEW.id_token := NULL;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER accounts_discard_provider_tokens BEFORE INSERT OR UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION commonair_discard_provider_tokens();
--> statement-breakpoint
-- Tokens stored before this migration (no production instances yet, only staging).
UPDATE public.accounts SET access_token = NULL, refresh_token = NULL, id_token = NULL
  WHERE access_token IS NOT NULL OR refresh_token IS NOT NULL OR id_token IS NOT NULL;
