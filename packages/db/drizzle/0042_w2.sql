CREATE TYPE "public"."attestation_kind" AS ENUM('broadcast', 'supersede', 'reissue');--> statement-breakpoint
CREATE TYPE "public"."broadcast_kind" AS ENUM('live', 'rehearsal');--> statement-breakpoint
CREATE TYPE "public"."caption_track_status" AS ENUM('queued', 'active', 'ready', 'failed', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."exclusion_category" AS ENUM('datacenter', 'privacy_relay', 'concurrency', 'automation', 'playback_pattern', 'other');--> statement-breakpoint
CREATE TYPE "public"."playback_mode" AS ENUM('live', 'dvr');--> statement-breakpoint
CREATE TYPE "public"."split_acceptance_decision" AS ENUM('accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."split_basis" AS ENUM('tips', 'subs', 'all');--> statement-breakpoint
CREATE TYPE "public"."split_status" AS ENUM('proposed', 'accepted', 'ended', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."split_writeoff_status" AS ENUM('proposed', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "revenue_split_acceptances" (
	"split_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"decision" "split_acceptance_decision" NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revenue_split_acceptances_split_id_recipient_user_id_pk" PRIMARY KEY("split_id","recipient_user_id")
);
--> statement-breakpoint
CREATE TABLE "revenue_split_postings" (
	"ledger_transaction_id" uuid PRIMARY KEY NOT NULL,
	"split_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revenue_split_shares" (
	"split_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"bps" integer NOT NULL,
	CONSTRAINT "revenue_split_shares_split_id_recipient_user_id_pk" PRIMARY KEY("split_id","recipient_user_id"),
	CONSTRAINT "revenue_split_shares_bps" CHECK ("revenue_split_shares"."bps" between 1 and 9999)
);
--> statement-breakpoint
CREATE TABLE "revenue_splits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "split_status" DEFAULT 'proposed' NOT NULL,
	"basis" "split_basis" NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "revenue_splits_version_positive" CHECK ("revenue_splits"."version" > 0),
	CONSTRAINT "revenue_splits_window" CHECK ("revenue_splits"."ends_at" is null or "revenue_splits"."ends_at" >= "revenue_splits"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "split_writeoff_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"status" "split_writeoff_status" DEFAULT 'proposed' NOT NULL,
	"proposed_by_id" uuid NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by_id" uuid,
	"decided_at" timestamp with time zone,
	"ledger_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "split_writeoff_proposals_amount" CHECK ("split_writeoff_proposals"."amount_cents" > 0),
	CONSTRAINT "split_writeoff_proposals_currency" CHECK ("split_writeoff_proposals"."currency" ~ '^[a-z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "broadcast_caption_tracks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"vod_id" uuid,
	"language" text NOT NULL,
	"status" "caption_track_status" DEFAULT 'queued' NOT NULL,
	"storage_key" text,
	"cue_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broadcast_caption_tracks_language" CHECK ("broadcast_caption_tracks"."language" ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$')
);
--> statement-breakpoint
CREATE TABLE "caption_edits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"track_id" uuid NOT NULL,
	"editor_user_id" uuid,
	"cues_changed" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "caption_edits_cues_changed" CHECK ("caption_edits"."cues_changed" > 0)
);
--> statement-breakpoint
CREATE TABLE "rehearsal_invitees" (
	"arm_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"broadcast_id" uuid,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rehearsal_invitees_arm_id_user_id_pk" PRIMARY KEY("arm_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "analytics_share_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_share_links_expiry" CHECK ("analytics_share_links"."expires_at" > "analytics_share_links"."created_at")
);
--> statement-breakpoint
CREATE TABLE "attestation_share_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attestation_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attestation_share_links_expiry" CHECK ("attestation_share_links"."expires_at" > "attestation_share_links"."created_at")
);
--> statement-breakpoint
CREATE TABLE "broadcast_audience_minutes" (
	"broadcast_id" uuid NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"verified" integer DEFAULT 0 NOT NULL,
	"unverified" integer DEFAULT 0 NOT NULL,
	"excluded" integer DEFAULT 0 NOT NULL,
	"excluded_by_category" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verified_by_source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw_by_source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "broadcast_audience_minutes_broadcast_id_minute_pk" PRIMARY KEY("broadcast_id","minute"),
	CONSTRAINT "broadcast_audience_minutes_counts" CHECK ("broadcast_audience_minutes"."verified" >= 0 and "broadcast_audience_minutes"."unverified" >= 0 and "broadcast_audience_minutes"."excluded" >= 0)
);
--> statement-breakpoint
CREATE TABLE "broadcast_audience_totals" (
	"broadcast_id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"duration_seconds" integer NOT NULL,
	"sessions" integer NOT NULL,
	"peak_verified_concurrent" integer NOT NULL,
	"verified_viewer_seconds" bigint NOT NULL,
	"unverified_viewer_seconds" bigint NOT NULL,
	"excluded_viewer_seconds" bigint NOT NULL,
	"excluded_seconds_by_category" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"excluded_sessions_by_category" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bytes_by_source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verified_seconds_by_source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rolled_up_at" timestamp with time zone DEFAULT now() NOT NULL,
	"minutes_purged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "broadcast_costs" (
	"broadcast_id" uuid PRIMARY KEY NOT NULL,
	"currency" text NOT NULL,
	"cost_cents" bigint NOT NULL,
	"bytes_by_source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broadcast_costs_cents" CHECK ("broadcast_costs"."cost_cents" >= 0),
	CONSTRAINT "broadcast_costs_currency" CHECK ("broadcast_costs"."currency" ~ '^[a-z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "integrity_attestations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" "attestation_kind" NOT NULL,
	"kid" text NOT NULL,
	"payload" text NOT NULL,
	"signature" text NOT NULL,
	"entry_hash" text NOT NULL,
	"prev_hash" text,
	"supersedes" text,
	"signed_at" timestamp with time zone NOT NULL,
	"breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"salt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrity_attestations_seq" CHECK ("integrity_attestations"."seq" > 0),
	CONSTRAINT "integrity_attestations_supersedes" CHECK (("integrity_attestations"."kind" = 'broadcast') = ("integrity_attestations"."supersedes" is null))
);
--> statement-breakpoint
CREATE TABLE "integrity_signing_keys" (
	"kid" text PRIMARY KEY NOT NULL,
	"algorithm" text DEFAULT 'Ed25519' NOT NULL,
	"public_key" text NOT NULL,
	"first_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"compromised_at" timestamp with time zone,
	CONSTRAINT "integrity_signing_keys_algorithm" CHECK ("integrity_signing_keys"."algorithm" = 'Ed25519'),
	CONSTRAINT "integrity_signing_keys_kid" CHECK ("integrity_signing_keys"."kid" ~ '^[A-Za-z0-9_-]{22}$')
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "captions_settings" jsonb DEFAULT '{"enabled":null,"spokenLanguage":null,"maskWords":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "dvr_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "dvr_window_seconds" integer DEFAULT 1800 NOT NULL;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN "kind" "broadcast_kind" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "playback_sessions" ADD COLUMN "playback_mode" "playback_mode" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "playback_sessions" ADD COLUMN "dvr_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "appeals" ADD COLUMN "rule_ref" text;--> statement-breakpoint
ALTER TABLE "appeals" ADD COLUMN "exclusion_category" "exclusion_category";--> statement-breakpoint
ALTER TABLE "mod_actions" ADD COLUMN "rule_ref" text;--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD COLUMN "rule_ref" text;--> statement-breakpoint
ALTER TABLE "revenue_split_acceptances" ADD CONSTRAINT "revenue_split_acceptances_split_id_revenue_splits_id_fk" FOREIGN KEY ("split_id") REFERENCES "public"."revenue_splits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_split_acceptances" ADD CONSTRAINT "revenue_split_acceptances_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_split_postings" ADD CONSTRAINT "revenue_split_postings_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_split_postings" ADD CONSTRAINT "revenue_split_postings_split_id_revenue_splits_id_fk" FOREIGN KEY ("split_id") REFERENCES "public"."revenue_splits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_split_shares" ADD CONSTRAINT "revenue_split_shares_split_id_revenue_splits_id_fk" FOREIGN KEY ("split_id") REFERENCES "public"."revenue_splits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_split_shares" ADD CONSTRAINT "revenue_split_shares_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_splits" ADD CONSTRAINT "revenue_splits_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_writeoff_proposals" ADD CONSTRAINT "split_writeoff_proposals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_writeoff_proposals" ADD CONSTRAINT "split_writeoff_proposals_proposed_by_id_users_id_fk" FOREIGN KEY ("proposed_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_writeoff_proposals" ADD CONSTRAINT "split_writeoff_proposals_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_writeoff_proposals" ADD CONSTRAINT "split_writeoff_proposals_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_caption_tracks" ADD CONSTRAINT "broadcast_caption_tracks_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_caption_tracks" ADD CONSTRAINT "broadcast_caption_tracks_vod_id_vods_id_fk" FOREIGN KEY ("vod_id") REFERENCES "public"."vods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caption_edits" ADD CONSTRAINT "caption_edits_track_id_broadcast_caption_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."broadcast_caption_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caption_edits" ADD CONSTRAINT "caption_edits_editor_user_id_users_id_fk" FOREIGN KEY ("editor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rehearsal_invitees" ADD CONSTRAINT "rehearsal_invitees_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rehearsal_invitees" ADD CONSTRAINT "rehearsal_invitees_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rehearsal_invitees" ADD CONSTRAINT "rehearsal_invitees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_share_links" ADD CONSTRAINT "analytics_share_links_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_share_links" ADD CONSTRAINT "analytics_share_links_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_share_links" ADD CONSTRAINT "analytics_share_links_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attestation_share_links" ADD CONSTRAINT "attestation_share_links_attestation_id_integrity_attestations_id_fk" FOREIGN KEY ("attestation_id") REFERENCES "public"."integrity_attestations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attestation_share_links" ADD CONSTRAINT "attestation_share_links_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_audience_minutes" ADD CONSTRAINT "broadcast_audience_minutes_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_audience_totals" ADD CONSTRAINT "broadcast_audience_totals_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_audience_totals" ADD CONSTRAINT "broadcast_audience_totals_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_costs" ADD CONSTRAINT "broadcast_costs_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrity_attestations" ADD CONSTRAINT "integrity_attestations_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrity_attestations" ADD CONSTRAINT "integrity_attestations_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrity_attestations" ADD CONSTRAINT "integrity_attestations_kid_integrity_signing_keys_kid_fk" FOREIGN KEY ("kid") REFERENCES "public"."integrity_signing_keys"("kid") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "revenue_split_postings_split_idx" ON "revenue_split_postings" USING btree ("split_id");--> statement-breakpoint
CREATE INDEX "revenue_split_shares_recipient_idx" ON "revenue_split_shares" USING btree ("recipient_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "revenue_splits_version_uq" ON "revenue_splits" USING btree ("channel_id","version");--> statement-breakpoint
CREATE INDEX "revenue_splits_active_idx" ON "revenue_splits" USING btree ("channel_id","starts_at") WHERE "revenue_splits"."status" in ('accepted', 'ended');--> statement-breakpoint
CREATE INDEX "split_writeoff_proposals_owner_idx" ON "split_writeoff_proposals" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "split_writeoff_proposals_open_uq" ON "split_writeoff_proposals" USING btree ("owner_user_id","currency") WHERE "split_writeoff_proposals"."status" = 'proposed';--> statement-breakpoint
CREATE UNIQUE INDEX "split_writeoff_proposals_tx_uq" ON "split_writeoff_proposals" USING btree ("ledger_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "broadcast_caption_tracks_language_uq" ON "broadcast_caption_tracks" USING btree ("broadcast_id","language");--> statement-breakpoint
CREATE INDEX "broadcast_caption_tracks_vod_idx" ON "broadcast_caption_tracks" USING btree ("vod_id");--> statement-breakpoint
CREATE INDEX "caption_edits_track_idx" ON "caption_edits" USING btree ("track_id","created_at");--> statement-breakpoint
CREATE INDEX "caption_edits_editor_idx" ON "caption_edits" USING btree ("editor_user_id");--> statement-breakpoint
CREATE INDEX "rehearsal_invitees_broadcast_idx" ON "rehearsal_invitees" USING btree ("broadcast_id");--> statement-breakpoint
CREATE INDEX "rehearsal_invitees_user_idx" ON "rehearsal_invitees" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_share_links_token_uq" ON "analytics_share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "analytics_share_links_channel_idx" ON "analytics_share_links" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "attestation_share_links_token_uq" ON "attestation_share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "attestation_share_links_attestation_idx" ON "attestation_share_links" USING btree ("attestation_id");--> statement-breakpoint
CREATE INDEX "broadcast_audience_minutes_minute_idx" ON "broadcast_audience_minutes" USING btree ("minute");--> statement-breakpoint
CREATE INDEX "broadcast_audience_totals_channel_idx" ON "broadcast_audience_totals" USING btree ("channel_id","rolled_up_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integrity_attestations_seq_uq" ON "integrity_attestations" USING btree ("channel_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "integrity_attestations_entry_hash_uq" ON "integrity_attestations" USING btree ("entry_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "integrity_attestations_broadcast_uq" ON "integrity_attestations" USING btree ("broadcast_id") WHERE "integrity_attestations"."kind" = 'broadcast';--> statement-breakpoint
CREATE INDEX "integrity_attestations_broadcast_idx" ON "integrity_attestations" USING btree ("broadcast_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "integrity_signing_keys_public_key_uq" ON "integrity_signing_keys" USING btree ("public_key");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_dvr_window_range" CHECK ("channels"."dvr_window_seconds" between 60 and 86400);--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_rule_ref_format" CHECK ("appeals"."rule_ref" is null or "appeals"."rule_ref" ~ '^[a-z][a-z0-9.-]*@[1-9][0-9]*$');--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_exclusion_category" CHECK (("appeals"."subject_type" = 'exclusion_group') = ("appeals"."exclusion_category" is not null));--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_exclusion_group_kind" CHECK ("appeals"."subject_type" <> 'exclusion_group' or "appeals"."kind" = 'integrity');--> statement-breakpoint
ALTER TABLE "mod_actions" ADD CONSTRAINT "mod_actions_rule_ref_format" CHECK ("mod_actions"."rule_ref" is null or "mod_actions"."rule_ref" ~ '^[a-z][a-z0-9.-]*@[1-9][0-9]*$');--> statement-breakpoint
ALTER TABLE "mod_actions" ADD CONSTRAINT "mod_actions_rule_ref_platform" CHECK ("mod_actions"."rule_ref" is null or "mod_actions"."scope" = 'platform');--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_rule_ref_format" CHECK ("moderation_cases"."rule_ref" is null or "moderation_cases"."rule_ref" ~ '^[a-z][a-z0-9.-]*@[1-9][0-9]*$');