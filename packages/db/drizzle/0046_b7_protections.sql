-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Batch 7 protections (W3, N3, N4; .claude/briefs/w3/contract-step.md §3.2), in addition to 0001,
-- 0016, 0021, 0025, 0029, 0034, 0038 and 0043, against a caller with ordinary DML on every table
-- who does not own them (AGENTS.md rule 9):
--   1. Follower count (decision (aa)): `channels.follower_count` is the count of non-excluded
--      follows, kept by a trigger on `follows` (insert, delete, `excluded_at` and `channel_id`
--      changes) and recounted once here. A direct write of the column is refused unless it comes
--      from that trigger (trigger depth 2) or the table owner. A follow's `move_link_id` names a
--      link of the same channel.
--   2. Watch rooms (ADR 0017 decision 3, decision (q)): a room's band is its host's on
--      `current_date`; a member's band must equal the room's; a null or invalid birth date is
--      refused (fail closed); a room on mature content (channel, broadcast or category) is adult
--      only and every member has confirmed mature viewing; an ended room takes no members; at most
--      `ROOM_LIMITS.maxMembers` (8) active members. A room's host, channel, broadcast and band never
--      change; a member row never re-opens.
--   3. Draws (decision (s)): `seed_commitment` is immutable on `giveaways` and `jury_panels`;
--      `seed` is set once, only if SHA-256 of the seed equals the commitment (the seed's hex-decoded
--      bytes, or its UTF-8 text); a drawn giveaway has its seed. `giveaway_entries` take inserts only
--      while the giveaway is open and before `closes_at`, never change, and are deleted only while
--      it is open; `giveaway_winners` are entrants, append-only. One open giveaway per channel is
--      the 0045 partial unique index.
--   4. Predictions (decision (v)): a bet with `media_ts >= lock_media_ts` is refused, and the
--      channel's owner, moderators and editors cannot bet.
--   5. Jury (decision (u)): a seat needs an active membership, no staff role, a known adult age
--      and a live opt-in; a vote comes only from a seat of the case's panel while the panel is open
--      and is append-only; `jury_cases` refuse T0 and NCII cases, anything under an active legal
--      hold, and `watch_room` or NCII reports.
--   6. Federation (ADR 0030): `federation_actor_keys` is append-only.
--   7. Move links (decision (k)): at most `MOVE_LINK_RULES.maxActive` (10) unrevoked, unexpired
--      links per channel; a revoked link stays revoked. Portability signing keys follow the
--      integrity signing keys' rule (append-only except `retired_at`, `compromised_at` once each).
--   8. Relay purges (decision (x)): rows never change, and are deleted only after 7 days.
--   9. Governance: the `jury.*` settings are shape- and range-checked like `JurySetting*` in
--      @commonair/contracts.
--  10. Seed data: `surgeGuard.onRaid` = true backfilled into stored chat settings.
--  11. commonair_configure_app_role: the app loses UPDATE/DELETE on the append-only tables above
--      and gains USAGE on sequences (`relay_purges.seq`, the first serial column). Every new table
--      gets DML through the existing `GRANT … ON ALL TABLES`; the migrate job re-runs it.
-- "Cascade" below means a delete made by a foreign key's ON DELETE CASCADE (trigger depth > 1).
-- Functions pin search_path and schema-qualify tables (ADR 0004).

-- 1. Follower count ------------------------------------------------------------------------
UPDATE public.channels c
   SET follower_count = n.cnt
  FROM (SELECT ch.id, (SELECT count(*) FROM public.follows f WHERE f.channel_id = ch.id AND f.excluded_at IS NULL)::int AS cnt
          FROM public.channels ch) n
 WHERE n.id = c.id AND c.follower_count IS DISTINCT FROM n.cnt;
--> statement-breakpoint

CREATE FUNCTION commonair_follows_count() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.channel_id = NEW.channel_id
     AND (OLD.excluded_at IS NULL) = (NEW.excluded_at IS NULL) THEN
    RETURN NULL;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.excluded_at IS NULL THEN
    UPDATE public.channels SET follower_count = greatest(follower_count - 1, 0) WHERE id = OLD.channel_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.excluded_at IS NULL THEN
    UPDATE public.channels SET follower_count = follower_count + 1 WHERE id = NEW.channel_id;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER follows_follower_count AFTER INSERT OR DELETE OR UPDATE OF excluded_at, channel_id ON public.follows
  FOR EACH ROW EXECUTE FUNCTION commonair_follows_count();
--> statement-breakpoint

CREATE FUNCTION commonair_follower_count_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.commonair_is_owner(TG_RELID) OR pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT' AND NEW.follower_count <> 0)
     OR (TG_OP = 'UPDATE' AND NEW.follower_count IS DISTINCT FROM OLD.follower_count) THEN
    RAISE EXCEPTION 'channels.follower_count is kept by the follows trigger' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER channels_follower_count_guard BEFORE INSERT OR UPDATE OF follower_count ON public.channels
  FOR EACH ROW EXECUTE FUNCTION commonair_follower_count_guard();
--> statement-breakpoint

CREATE FUNCTION commonair_follows_move_link() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.move_link_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.move_links l WHERE l.id = NEW.move_link_id AND l.channel_id = NEW.channel_id) THEN
    RAISE EXCEPTION 'a follow''s move link belongs to the followed channel' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER follows_move_link BEFORE INSERT OR UPDATE OF move_link_id, channel_id ON public.follows
  FOR EACH ROW EXECUTE FUNCTION commonair_follows_move_link();
--> statement-breakpoint

-- 2. Watch rooms ---------------------------------------------------------------------------
-- 'adult' at 18 (as `isAdult` in services/api/src/auth/identity.ts); null for an unknown or
-- invalid birth date (null, in the future, or before 1900), which every caller refuses.
CREATE FUNCTION commonair_age_band(u uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE
           WHEN x.birth_date IS NULL OR x.birth_date > current_date OR x.birth_date < date '1900-01-01' THEN NULL
           WHEN x.birth_date <= (current_date - interval '18 years')::date THEN 'adult'
           ELSE 'minor'
         END
    FROM public.users x WHERE x.id = u
$$;
--> statement-breakpoint

-- Mature content: the channel's label, the broadcast's, or the category of either.
CREATE FUNCTION commonair_room_mature(b uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(bool_or(c.mature OR br.mature OR coalesce(bc.mature, false) OR coalesce(cc.mature, false)), false)
    FROM public.broadcasts br
    JOIN public.channels c ON c.id = br.channel_id
    LEFT JOIN public.categories bc ON bc.id = br.category_id
    LEFT JOIN public.categories cc ON cc.id = c.category_id
   WHERE br.id = b
$$;
--> statement-breakpoint

CREATE FUNCTION commonair_watch_room_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE band text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.host_id IS DISTINCT FROM OLD.host_id OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
       OR NEW.broadcast_id IS DISTINCT FROM OLD.broadcast_id OR NEW.age_band IS DISTINCT FROM OLD.age_band THEN
      RAISE EXCEPTION 'a watch room''s host, channel, broadcast and band never change' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.ended_at IS NOT NULL AND NEW.ended_at IS NULL THEN
      RAISE EXCEPTION 'an ended watch room stays ended' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.broadcasts b WHERE b.id = NEW.broadcast_id AND b.channel_id = NEW.channel_id) THEN
    RAISE EXCEPTION 'a watch room is on a broadcast of its channel' USING ERRCODE = 'check_violation';
  END IF;
  band := public.commonair_age_band(NEW.host_id);
  IF band IS NULL THEN
    RAISE EXCEPTION 'watch room host has no valid birth date' USING ERRCODE = 'check_violation';
  END IF;
  IF band IS DISTINCT FROM NEW.age_band::text THEN
    RAISE EXCEPTION 'a watch room''s band is its host''s' USING ERRCODE = 'check_violation';
  END IF;
  IF public.commonair_room_mature(NEW.broadcast_id) AND (band <> 'adult' OR NOT EXISTS (
       SELECT 1 FROM public.users u WHERE u.id = NEW.host_id AND u.mature_confirmed_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'a watch room on mature content is for adults who confirmed mature viewing' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER watch_rooms_guard BEFORE INSERT OR UPDATE ON public.watch_rooms
  FOR EACH ROW EXECUTE FUNCTION commonair_watch_room_guard();
--> statement-breakpoint

CREATE FUNCTION commonair_watch_room_member_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.watch_rooms;
  band text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.room_id IS DISTINCT FROM OLD.room_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.joined_at IS DISTINCT FROM OLD.joined_at OR (OLD.left_at IS NOT NULL AND NEW.left_at IS DISTINCT FROM OLD.left_at) THEN
      RAISE EXCEPTION 'a watch room membership only gains left_at, once' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  -- The room row lock serializes joins, so two concurrent joins cannot both take the last place.
  SELECT * INTO r FROM public.watch_rooms WHERE id = NEW.room_id FOR UPDATE;
  IF r.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'room_closed: the watch room has ended' USING ERRCODE = 'check_violation';
  END IF;
  band := public.commonair_age_band(NEW.user_id);
  IF band IS NULL THEN
    RAISE EXCEPTION 'room_age_band: no valid birth date' USING ERRCODE = 'check_violation';
  END IF;
  IF band <> r.age_band::text THEN
    RAISE EXCEPTION 'room_age_band: the member''s band differs from the room''s' USING ERRCODE = 'check_violation';
  END IF;
  IF public.commonair_room_mature(r.broadcast_id) AND (band <> 'adult' OR NOT EXISTS (
       SELECT 1 FROM public.users u WHERE u.id = NEW.user_id AND u.mature_confirmed_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'room_mature: mature content is for adults who confirmed mature viewing' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.left_at IS NULL AND (SELECT count(*) FROM public.watch_room_members m
                               WHERE m.room_id = NEW.room_id AND m.left_at IS NULL) >= 8 THEN
    RAISE EXCEPTION 'room_full: a watch room has at most 8 members' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER watch_room_members_guard BEFORE INSERT OR UPDATE ON public.watch_room_members
  FOR EACH ROW EXECUTE FUNCTION commonair_watch_room_member_guard();
--> statement-breakpoint

-- 3. Draws (giveaways and jury panels) ------------------------------------------------------
CREATE FUNCTION commonair_seed_matches(seed text, commitment text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT seed IS NOT NULL AND commitment IS NOT NULL AND (
    (seed ~ '^([0-9a-f]{2})+$' AND encode(sha256(decode(seed, 'hex')), 'hex') = commitment)
    OR encode(sha256(convert_to(seed, 'UTF8')), 'hex') = commitment)
$$;
--> statement-breakpoint

-- Shared by giveaways and jury panels: the commitment never changes; the seed starts null and is
-- revealed once, matching the commitment.
CREATE FUNCTION commonair_draw_commitment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.seed IS NOT NULL THEN
      RAISE EXCEPTION 'a draw''s seed is revealed after it opens, never at insert' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.seed_commitment IS DISTINCT FROM OLD.seed_commitment OR NEW.sealed_seed IS DISTINCT FROM OLD.sealed_seed THEN
    RAISE EXCEPTION 'a draw''s seed commitment never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.seed IS NOT NULL AND NEW.seed IS DISTINCT FROM OLD.seed THEN
    RAISE EXCEPTION 'a draw''s seed is revealed once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.seed IS NULL AND NEW.seed IS NOT NULL AND NOT public.commonair_seed_matches(NEW.seed, NEW.seed_commitment) THEN
    RAISE EXCEPTION 'the revealed seed does not match the commitment' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER giveaways_commitment BEFORE INSERT OR UPDATE ON public.giveaways
  FOR EACH ROW EXECUTE FUNCTION commonair_draw_commitment_guard();
--> statement-breakpoint
CREATE TRIGGER jury_panels_commitment BEFORE INSERT OR UPDATE ON public.jury_panels
  FOR EACH ROW EXECUTE FUNCTION commonair_draw_commitment_guard();
--> statement-breakpoint

CREATE FUNCTION commonair_giveaway_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION 'a giveaway starts open' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.channel_id IS DISTINCT FROM OLD.channel_id OR NEW.salt IS DISTINCT FROM OLD.salt
     OR NEW.winner_count IS DISTINCT FROM OLD.winner_count OR NEW.eligibility IS DISTINCT FROM OLD.eligibility
     OR NEW.opens_at IS DISTINCT FROM OLD.opens_at THEN
    RAISE EXCEPTION 'a giveaway''s channel, salt, winner count, eligibility and opening never change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'open' AND NEW.status IN ('closed', 'cancelled'))
       OR (OLD.status = 'closed' AND NEW.status IN ('drawn', 'cancelled'))) THEN
    RAISE EXCEPTION 'giveaway status % cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'drawn' AND NEW.seed IS NULL THEN
    RAISE EXCEPTION 'a drawn giveaway has its seed revealed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER giveaways_guard BEFORE INSERT OR UPDATE ON public.giveaways
  FOR EACH ROW EXECUTE FUNCTION commonair_giveaway_guard();
--> statement-breakpoint

CREATE FUNCTION commonair_giveaway_entry_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE g public.giveaways;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a giveaway entry never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    SELECT * INTO g FROM public.giveaways WHERE id = OLD.giveaway_id;
    IF g.status <> 'open' THEN
      RAISE EXCEPTION 'entries are withdrawn only while the giveaway is open' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  -- FOR SHARE: a close in flight either commits first (and is seen) or waits for this entry.
  SELECT * INTO g FROM public.giveaways WHERE id = NEW.giveaway_id FOR SHARE;
  IF g.status <> 'open' OR (g.closes_at IS NOT NULL AND clock_timestamp() >= g.closes_at) THEN
    RAISE EXCEPTION 'the giveaway is closed to entries' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER giveaway_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON public.giveaway_entries
  FOR EACH ROW EXECUTE FUNCTION commonair_giveaway_entry_guard();
--> statement-breakpoint

-- Append-only rows that go only with their parent (a cascade).
CREATE FUNCTION commonair_append_only_cascade() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'table % is append-only (% rejected)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint

CREATE FUNCTION commonair_giveaway_winner_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.giveaway_entries e WHERE e.giveaway_id = NEW.giveaway_id AND e.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'a giveaway winner is an entrant' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.giveaways g WHERE g.id = NEW.giveaway_id AND g.status IN ('closed', 'drawn')
                 AND NEW.rank <= g.winner_count) THEN
    RAISE EXCEPTION 'winners are drawn after entries close, at most winner_count' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER giveaway_winners_insert BEFORE INSERT ON public.giveaway_winners
  FOR EACH ROW EXECUTE FUNCTION commonair_giveaway_winner_guard();
--> statement-breakpoint
CREATE TRIGGER giveaway_winners_append_only BEFORE UPDATE OR DELETE ON public.giveaway_winners
  FOR EACH ROW EXECUTE FUNCTION commonair_append_only_cascade();
--> statement-breakpoint
CREATE TRIGGER giveaway_winners_no_truncate BEFORE TRUNCATE ON public.giveaway_winners
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 4. Predictions ---------------------------------------------------------------------------
CREATE FUNCTION commonair_prediction_bet_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE p public.predictions;
BEGIN
  SELECT * INTO p FROM public.predictions WHERE id = NEW.prediction_id;
  IF NEW.media_ts IS NOT NULL AND p.lock_media_ts IS NOT NULL AND NEW.media_ts >= p.lock_media_ts THEN
    RAISE EXCEPTION 'the bet is at or after the media time betting locked at' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND (
       EXISTS (SELECT 1 FROM public.channels c WHERE c.id = p.channel_id AND c.owner_id = NEW.user_id)
       OR EXISTS (SELECT 1 FROM public.channel_roles r WHERE r.channel_id = p.channel_id AND r.user_id = NEW.user_id
                    AND r.role IN ('moderator', 'editor'))) THEN
    RAISE EXCEPTION 'the channel''s owner, moderators and editors cannot bet' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER prediction_bets_guard BEFORE INSERT OR UPDATE OF media_ts, prediction_id, user_id ON public.prediction_bets
  FOR EACH ROW EXECUTE FUNCTION commonair_prediction_bet_guard();
--> statement-breakpoint

-- 5. Jury ----------------------------------------------------------------------------------
CREATE FUNCTION commonair_jury_seat_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.panel_id IS DISTINCT FROM OLD.panel_id OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    RAISE EXCEPTION 'a jury seat never changes hands' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.memberships m JOIN public.users u ON u.id = m.user_id
                  WHERE m.user_id = NEW.user_id AND m.status = 'active' AND u.deleted_at IS NULL AND NOT u.banned) THEN
    RAISE EXCEPTION 'a juror is an active member' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.users u WHERE u.id = NEW.user_id AND u.role <> 'user') THEN
    RAISE EXCEPTION 'staff never sit on the jury' USING ERRCODE = 'check_violation';
  END IF;
  IF public.commonair_age_band(NEW.user_id) IS DISTINCT FROM 'adult' THEN
    RAISE EXCEPTION 'a juror is a known adult' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.jury_optins o WHERE o.user_id = NEW.user_id AND o.opted_out_at IS NULL) THEN
    RAISE EXCEPTION 'a juror has opted in' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER jury_seats_guard BEFORE INSERT OR UPDATE ON public.jury_seats
  FOR EACH ROW EXECUTE FUNCTION commonair_jury_seat_guard();
--> statement-breakpoint

CREATE FUNCTION commonair_jury_case_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  mc public.moderation_cases;
  rp public.reports;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.panel_id IS DISTINCT FROM OLD.panel_id OR NEW.subject_kind IS DISTINCT FROM OLD.subject_kind
                           OR NEW.subject_id IS DISTINCT FROM OLD.subject_id) THEN
    RAISE EXCEPTION 'a jury case''s subject never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.subject_kind = 'moderation_case' THEN
    SELECT * INTO mc FROM public.moderation_cases WHERE id = NEW.subject_id;
    IF mc.id IS NULL THEN
      RAISE EXCEPTION 'a jury case names a moderation case' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF mc.tier = 't0' OR mc.list_category IS NOT NULL OR mc.status = 'dismissal_pending' THEN
      RAISE EXCEPTION 'T0 and hash-list (CSAM, NCII) cases are never sampled' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.legal_holds h WHERE h.released_at IS NULL
                AND (h.case_id = mc.id OR h.user_id = mc.user_id
                     OR h.user_id = (SELECT c.owner_id FROM public.channels c WHERE c.id = mc.channel_id))) THEN
      RAISE EXCEPTION 'cases under legal hold are never sampled' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT * INTO rp FROM public.reports WHERE id = NEW.subject_id;
    IF rp.id IS NULL THEN
      RAISE EXCEPTION 'a jury case names a report' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF rp.subject_type = 'watch_room' OR rp.reason = 'ncii' THEN
      RAISE EXCEPTION 'watch-room and NCII reports are never sampled' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.legal_holds h WHERE h.released_at IS NULL
                AND (h.user_id = rp.reporter_id
                     OR (rp.subject_type = 'user' AND h.user_id = rp.subject_id)
                     OR h.user_id = (SELECT c.owner_id FROM public.channels c WHERE c.id = rp.channel_id))) THEN
      RAISE EXCEPTION 'reports under legal hold are never sampled' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER jury_cases_guard BEFORE INSERT OR UPDATE ON public.jury_cases
  FOR EACH ROW EXECUTE FUNCTION commonair_jury_case_guard();
--> statement-breakpoint

CREATE FUNCTION commonair_jury_vote_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.jury_cases jc
                   JOIN public.jury_seats s ON s.panel_id = jc.panel_id
                   JOIN public.jury_panels p ON p.id = jc.panel_id
                  WHERE jc.id = NEW.case_id AND s.id = NEW.seat_id AND p.closed_at IS NULL) THEN
    RAISE EXCEPTION 'only a seat of the case''s open panel votes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER jury_votes_insert BEFORE INSERT ON public.jury_votes
  FOR EACH ROW EXECUTE FUNCTION commonair_jury_vote_guard();
--> statement-breakpoint
CREATE TRIGGER jury_votes_append_only BEFORE UPDATE OR DELETE ON public.jury_votes
  FOR EACH ROW EXECUTE FUNCTION commonair_append_only_cascade();
--> statement-breakpoint
CREATE TRIGGER jury_votes_no_truncate BEFORE TRUNCATE ON public.jury_votes
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 6. Federation ----------------------------------------------------------------------------
CREATE TRIGGER federation_actor_keys_append_only BEFORE UPDATE OR DELETE ON public.federation_actor_keys
  FOR EACH ROW EXECUTE FUNCTION commonair_append_only_cascade();
--> statement-breakpoint
CREATE TRIGGER federation_actor_keys_no_truncate BEFORE TRUNCATE ON public.federation_actor_keys
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 7. Move links and portability signing keys ----------------------------------------------
CREATE FUNCTION commonair_move_link_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.channel_id IS DISTINCT FROM OLD.channel_id OR NEW.nonce_hash IS DISTINCT FROM OLD.nonce_hash THEN
      RAISE EXCEPTION 'a move link''s channel and nonce never change' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
      RAISE EXCEPTION 'a revoked move link stays revoked' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.revoked_at IS NOT NULL OR (NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.revoked_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('move-links:' || NEW.channel_id::text));
  IF (SELECT count(*) FROM public.move_links l
       WHERE l.channel_id = NEW.channel_id AND l.id <> NEW.id AND l.revoked_at IS NULL
         AND (l.expires_at IS NULL OR l.expires_at > clock_timestamp())) >= 10 THEN
    RAISE EXCEPTION 'a channel has at most 10 active move links' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER move_links_guard BEFORE INSERT OR UPDATE ON public.move_links
  FOR EACH ROW EXECUTE FUNCTION commonair_move_link_guard();
--> statement-breakpoint

CREATE TRIGGER portability_signing_keys_guard BEFORE INSERT OR UPDATE OR DELETE ON public.portability_signing_keys
  FOR EACH ROW EXECUTE FUNCTION commonair_integrity_signing_key_guard();
--> statement-breakpoint
CREATE TRIGGER portability_signing_keys_no_truncate BEFORE TRUNCATE ON public.portability_signing_keys
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 8. Relay purges --------------------------------------------------------------------------
CREATE FUNCTION commonair_relay_purge_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'relay purge rows never change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.created_at > clock_timestamp() - interval '7 days' THEN
    RAISE EXCEPTION 'relay purge rows are kept 7 days' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER relay_purges_guard BEFORE UPDATE OR DELETE ON public.relay_purges
  FOR EACH ROW EXECUTE FUNCTION commonair_relay_purge_guard();
--> statement-breakpoint
CREATE TRIGGER relay_purges_no_truncate BEFORE TRUNCATE ON public.relay_purges
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 9. Governance: the jury settings ---------------------------------------------------------
CREATE FUNCTION commonair_validate_jury_setting() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb := NEW.value;
BEGIN
  IF NEW.key = 'jury.enabled' AND jsonb_typeof(v->'enabled') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'jury.enabled needs a boolean enabled' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.key = 'jury.panelSize' AND (jsonb_typeof(v->'panelSize') IS DISTINCT FROM 'number'
       OR (v->>'panelSize')::numeric NOT BETWEEN 3 AND 25
       OR (v->>'panelSize')::numeric <> trunc((v->>'panelSize')::numeric)) THEN
    RAISE EXCEPTION 'jury.panelSize needs an integer panelSize between 3 and 25' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.key = 'jury.casesPerPanel' AND (jsonb_typeof(v->'casesPerPanel') IS DISTINCT FROM 'number'
       OR (v->>'casesPerPanel')::numeric NOT BETWEEN 1 AND 100
       OR (v->>'casesPerPanel')::numeric <> trunc((v->>'casesPerPanel')::numeric)) THEN
    RAISE EXCEPTION 'jury.casesPerPanel needs an integer casesPerPanel between 1 and 100' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER governance_settings_jury_ck BEFORE INSERT OR UPDATE ON public.governance_settings
  FOR EACH ROW WHEN (NEW.key IN ('jury.enabled', 'jury.panelSize', 'jury.casesPerPanel'))
  EXECUTE FUNCTION commonair_validate_jury_setting();
--> statement-breakpoint

-- 10. surgeGuard.onRaid defaults on in stored settings (decision (w)) ----------------------
UPDATE public.channels
   SET chat_settings = jsonb_set(chat_settings, '{surgeGuard,onRaid}', 'true'::jsonb)
 WHERE jsonb_typeof(chat_settings->'surgeGuard') = 'object' AND NOT (chat_settings->'surgeGuard' ? 'onRaid');
--> statement-breakpoint

-- 11. App role (additions only to 0043's version) ------------------------------------------
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
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', r);
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION commonair_configure_app_role(name) FROM PUBLIC;
