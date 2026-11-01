CREATE TYPE "public"."federation_delivery_status" AS ENUM('ok', 'failing', 'dropped');--> statement-breakpoint
CREATE TYPE "public"."federation_inbox_outcome" AS ENUM('accepted', 'ignored', 'rejected', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."federation_object_kind" AS ENUM('note', 'video');--> statement-breakpoint
CREATE TYPE "public"."federation_subject_kind" AS ENUM('broadcast', 'vod', 'clip');--> statement-breakpoint
CREATE TYPE "public"."follow_source" AS ENUM('direct', 'move_link', 'import');--> statement-breakpoint
CREATE TYPE "public"."giveaway_status" AS ENUM('open', 'closed', 'drawn', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('previewed', 'queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."jury_reason_code" AS ENUM('clause_fits', 'clause_does_not_fit', 'action_too_severe', 'action_too_lenient', 'context_missing', 'evidence_unclear', 'other');--> statement-breakpoint
CREATE TYPE "public"."jury_subject_kind" AS ENUM('moderation_case', 'report');--> statement-breakpoint
CREATE TYPE "public"."jury_vote" AS ENUM('agree', 'disagree', 'unsure');--> statement-breakpoint
CREATE TYPE "public"."jury_withdraw_reason" AS ENUM('legal_hold', 'ncii', 'appeal', 'ineligible');--> statement-breakpoint
CREATE TYPE "public"."portability_source" AS ENUM('commonair', 'twitch');--> statement-breakpoint
CREATE TYPE "public"."relay_purge_reason" AS ENUM('vod_hidden', 'clip_hidden', 'restricted', 'suspended', 'recording_ended');--> statement-breakpoint
CREATE TYPE "public"."room_age_band" AS ENUM('minor', 'adult');--> statement-breakpoint
CREATE TYPE "public"."room_end_reason" AS ENUM('host_closed', 'host_left', 'empty', 'broadcast_ended', 'mature', 'moderation', 'host_deleted');--> statement-breakpoint
ALTER TYPE "public"."export_kind" ADD VALUE 'bundle';--> statement-breakpoint
ALTER TYPE "public"."report_subject" ADD VALUE 'watch_room';--> statement-breakpoint
CREATE TABLE "follow_portability_grants" (
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follow_portability_grants_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "move_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"nonce_hash" text NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "move_links_nonce_hash" CHECK ("move_links"."nonce_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "federation_actor_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"public_key_pem" text NOT NULL,
	"key_created_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "federation_actors" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"key_id" text NOT NULL,
	"public_key_pem" text NOT NULL,
	"private_key_enc" text NOT NULL,
	"key_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "federation_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"inbox" text NOT NULL,
	"status" "federation_delivery_status" DEFAULT 'ok' NOT NULL,
	"first_failed_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "federation_domain_blocks" (
	"domain" text PRIMARY KEY NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "federation_followers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"inbox" text NOT NULL,
	"shared_inbox" text,
	"handle" text,
	"domain" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "federation_inbox_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid,
	"headers" jsonb NOT NULL,
	"body" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"outcome" "federation_inbox_outcome",
	CONSTRAINT "federation_inbox_items_processed" CHECK (("federation_inbox_items"."processed_at" is null) = ("federation_inbox_items"."outcome" is null))
);
--> statement-breakpoint
CREATE TABLE "federation_objects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"kind" "federation_object_kind" NOT NULL,
	"subject_kind" "federation_subject_kind" NOT NULL,
	"subject_id" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "giveaway_entries" (
	"giveaway_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"pseudonym" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "giveaway_entries_giveaway_id_user_id_pk" PRIMARY KEY("giveaway_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "giveaway_winners" (
	"giveaway_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rank" smallint NOT NULL,
	"draw_index" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "giveaway_winners_giveaway_id_rank_pk" PRIMARY KEY("giveaway_id","rank"),
	CONSTRAINT "giveaway_winners_rank" CHECK ("giveaway_winners"."rank" between 1 and 10 and "giveaway_winners"."draw_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "giveaways" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"title" text NOT NULL,
	"prize" text NOT NULL,
	"eligibility" jsonb NOT NULL,
	"winner_count" smallint NOT NULL,
	"keyword" text,
	"status" "giveaway_status" DEFAULT 'open' NOT NULL,
	"seed_commitment" text NOT NULL,
	"sealed_seed" text NOT NULL,
	"seed" text,
	"salt" text NOT NULL,
	"opens_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closes_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"drawn_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "giveaways_winner_count" CHECK ("giveaways"."winner_count" between 1 and 10),
	CONSTRAINT "giveaways_commitment" CHECK ("giveaways"."seed_commitment" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "giveaways_salt" CHECK ("giveaways"."salt" ~ '^([0-9a-f]{2}){16,64}$'),
	CONSTRAINT "giveaways_text" CHECK (length("giveaways"."title") between 1 and 60 and length("giveaways"."prize") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "jury_cases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"panel_id" uuid NOT NULL,
	"subject_kind" "jury_subject_kind" NOT NULL,
	"subject_id" uuid NOT NULL,
	"rule_ref" text,
	"pseudonym_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_reason" "jury_withdraw_reason",
	CONSTRAINT "jury_cases_withdrawn" CHECK (("jury_cases"."withdrawn_at" is null) = ("jury_cases"."withdrawn_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "jury_flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by_id" uuid,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "jury_optins" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"opted_in_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opted_out_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "jury_panels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"period" text NOT NULL,
	"seed_commitment" text NOT NULL,
	"sealed_seed" text NOT NULL,
	"seed" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "jury_panels_period" CHECK ("jury_panels"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "jury_panels_commitment" CHECK ("jury_panels"."seed_commitment" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "jury_seats" (
	"id" uuid PRIMARY KEY NOT NULL,
	"panel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jury_votes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"vote" "jury_vote" NOT NULL,
	"reason_code" "jury_reason_code" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portability_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"source" "portability_source" NOT NULL,
	"status" "import_status" DEFAULT 'previewed' NOT NULL,
	"archive_key" text,
	"preview" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"choices" jsonb,
	"result" jsonb,
	"asserted_at" timestamp with time zone,
	"assertion_version" text,
	"standing_verified" boolean,
	"standing_issuer" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "portability_imports_assertion" CHECK (("portability_imports"."asserted_at" is null) = ("portability_imports"."assertion_version" is null)),
	CONSTRAINT "portability_imports_twitch_standing" CHECK ("portability_imports"."source" <> 'twitch' or "portability_imports"."standing_verified" is null)
);
--> statement-breakpoint
CREATE TABLE "portability_signing_keys" (
	"kid" text PRIMARY KEY NOT NULL,
	"algorithm" text DEFAULT 'Ed25519' NOT NULL,
	"public_key" text NOT NULL,
	"first_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"compromised_at" timestamp with time zone,
	CONSTRAINT "portability_signing_keys_algorithm" CHECK ("portability_signing_keys"."algorithm" = 'Ed25519'),
	CONSTRAINT "portability_signing_keys_kid" CHECK ("portability_signing_keys"."kid" ~ '^[A-Za-z0-9_-]{22}$')
);
--> statement-breakpoint
CREATE TABLE "relay_purges" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"prefix" text NOT NULL,
	"reason" "relay_purge_reason" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_purges_prefix" CHECK (length("relay_purges"."prefix") between 1 and 256)
);
--> statement-breakpoint
CREATE TABLE "watch_room_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "watch_room_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"room_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_room_messages_body" CHECK (length("watch_room_messages"."body") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "watch_rooms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"host_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"age_band" "room_age_band" NOT NULL,
	"invite_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" "room_end_reason",
	CONSTRAINT "watch_rooms_end" CHECK (("watch_rooms"."ended_at" is null) = ("watch_rooms"."end_reason" is null)),
	CONSTRAINT "watch_rooms_invite_hash" CHECK ("watch_rooms"."invite_hash" is null or "watch_rooms"."invite_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "watch_rooms_invite_live" CHECK ("watch_rooms"."invite_hash" is not null or "watch_rooms"."ended_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "chat_settings" SET DEFAULT '{"slowModeSeconds":0,"followersOnlyMinutes":null,"subscribersOnly":false,"emoteOnly":false,"minAccountAgeDays":0,"requireVerifiedEmail":true,"linksAllowed":true,"minVerifiedWatchSeconds":0,"verifiedWatchExemptSubscribers":true,"surgeGuard":{"enabled":false,"triggerUnverifiedRatio":0.5,"cooldownMinutes":10,"onRaid":true}}'::jsonb;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "federation_settings" jsonb DEFAULT '{"enabled":false}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "moved_to" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "moved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "follows" ADD COLUMN "source" "follow_source" DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "follows" ADD COLUMN "move_link_id" uuid;--> statement-breakpoint
ALTER TABLE "prediction_bets" ADD COLUMN "media_ts" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "lock_media_ts" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "resolved_by_id" uuid;--> statement-breakpoint
ALTER TABLE "follow_portability_grants" ADD CONSTRAINT "follow_portability_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_portability_grants" ADD CONSTRAINT "follow_portability_grants_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_links" ADD CONSTRAINT "move_links_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_links" ADD CONSTRAINT "move_links_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_actor_keys" ADD CONSTRAINT "federation_actor_keys_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_actors" ADD CONSTRAINT "federation_actors_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_domain_blocks" ADD CONSTRAINT "federation_domain_blocks_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_followers" ADD CONSTRAINT "federation_followers_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_inbox_items" ADD CONSTRAINT "federation_inbox_items_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_objects" ADD CONSTRAINT "federation_objects_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giveaway_entries" ADD CONSTRAINT "giveaway_entries_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giveaway_entries" ADD CONSTRAINT "giveaway_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giveaway_winners" ADD CONSTRAINT "giveaway_winners_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giveaway_winners" ADD CONSTRAINT "giveaway_winners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giveaways" ADD CONSTRAINT "giveaways_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giveaways" ADD CONSTRAINT "giveaways_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jury_cases" ADD CONSTRAINT "jury_cases_panel_id_jury_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "public"."jury_panels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jury_flags" ADD CONSTRAINT "jury_flags_case_id_jury_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."jury_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jury_flags" ADD CONSTRAINT "jury_flags_resolved_by_id_users_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jury_optins" ADD CONSTRAINT "jury_optins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jury_seats" ADD CONSTRAINT "jury_seats_panel_id_jury_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "public"."jury_panels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jury_seats" ADD CONSTRAINT "jury_seats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jury_votes" ADD CONSTRAINT "jury_votes_case_id_jury_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."jury_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jury_votes" ADD CONSTRAINT "jury_votes_seat_id_jury_seats_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."jury_seats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portability_imports" ADD CONSTRAINT "portability_imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portability_imports" ADD CONSTRAINT "portability_imports_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_room_members" ADD CONSTRAINT "watch_room_members_room_id_watch_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."watch_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_room_members" ADD CONSTRAINT "watch_room_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_room_messages" ADD CONSTRAINT "watch_room_messages_room_id_watch_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."watch_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_room_messages" ADD CONSTRAINT "watch_room_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_rooms" ADD CONSTRAINT "watch_rooms_host_id_users_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_rooms" ADD CONSTRAINT "watch_rooms_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_rooms" ADD CONSTRAINT "watch_rooms_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "follow_portability_grants_channel_idx" ON "follow_portability_grants" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "move_links_nonce_hash_uq" ON "move_links" USING btree ("nonce_hash");--> statement-breakpoint
CREATE INDEX "move_links_channel_idx" ON "move_links" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "federation_actor_keys_channel_idx" ON "federation_actor_keys" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_deliveries_inbox_uq" ON "federation_deliveries" USING btree ("inbox");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_followers_channel_actor_uq" ON "federation_followers" USING btree ("channel_id","actor_id");--> statement-breakpoint
CREATE INDEX "federation_followers_domain_idx" ON "federation_followers" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "federation_inbox_items_received_idx" ON "federation_inbox_items" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_objects_subject_uq" ON "federation_objects" USING btree ("kind","subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "federation_objects_channel_idx" ON "federation_objects" USING btree ("channel_id","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "giveaway_entries_pseudonym_uq" ON "giveaway_entries" USING btree ("giveaway_id","pseudonym");--> statement-breakpoint
CREATE UNIQUE INDEX "giveaway_winners_user_uq" ON "giveaway_winners" USING btree ("giveaway_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "giveaways_channel_open_uq" ON "giveaways" USING btree ("channel_id") WHERE "giveaways"."status" = 'open';--> statement-breakpoint
CREATE INDEX "giveaways_channel_idx" ON "giveaways" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "giveaways_due_idx" ON "giveaways" USING btree ("closes_at") WHERE "giveaways"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "jury_cases_subject_uq" ON "jury_cases" USING btree ("panel_id","subject_kind","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jury_flags_case_uq" ON "jury_flags" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "jury_flags_open_idx" ON "jury_flags" USING btree ("resolved_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jury_panels_period_uq" ON "jury_panels" USING btree ("period");--> statement-breakpoint
CREATE UNIQUE INDEX "jury_seats_panel_user_uq" ON "jury_seats" USING btree ("panel_id","user_id");--> statement-breakpoint
CREATE INDEX "jury_seats_user_idx" ON "jury_seats" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jury_votes_case_seat_uq" ON "jury_votes" USING btree ("case_id","seat_id");--> statement-breakpoint
CREATE INDEX "portability_imports_channel_idx" ON "portability_imports" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "portability_imports_user_idx" ON "portability_imports" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portability_signing_keys_public_key_uq" ON "portability_signing_keys" USING btree ("public_key");--> statement-breakpoint
CREATE INDEX "relay_purges_created_idx" ON "relay_purges" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "watch_room_members_active_uq" ON "watch_room_members" USING btree ("room_id","user_id") WHERE "watch_room_members"."left_at" is null;--> statement-breakpoint
CREATE INDEX "watch_room_members_user_idx" ON "watch_room_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "watch_room_messages_room_idx" ON "watch_room_messages" USING btree ("room_id","created_at");--> statement-breakpoint
CREATE INDEX "watch_room_messages_author_idx" ON "watch_room_messages" USING btree ("author_id");--> statement-breakpoint
CREATE UNIQUE INDEX "watch_rooms_invite_hash_uq" ON "watch_rooms" USING btree ("invite_hash");--> statement-breakpoint
CREATE INDEX "watch_rooms_host_idx" ON "watch_rooms" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "watch_rooms_broadcast_idx" ON "watch_rooms" USING btree ("broadcast_id");--> statement-breakpoint
CREATE INDEX "watch_rooms_ended_idx" ON "watch_rooms" USING btree ("ended_at");--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_move_link_id_move_links_id_fk" FOREIGN KEY ("move_link_id") REFERENCES "public"."move_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_resolved_by_id_users_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "follows_move_link_idx" ON "follows" USING btree ("move_link_id") WHERE "follows"."move_link_id" is not null;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_moved_to_https" CHECK (("channels"."moved_to" is null) = ("channels"."moved_at" is null) and ("channels"."moved_to" is null or ("channels"."moved_to" ~ '^https://' and length("channels"."moved_to") <= 500)));--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_move_link_source" CHECK ("follows"."move_link_id" is null or "follows"."source" = 'move_link');