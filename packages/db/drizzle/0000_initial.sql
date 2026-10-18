CREATE TYPE "public"."account_type" AS ENUM('human', 'bot');--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('user', 'moderator', 'admin', 'system', 'bot', 'app');--> statement-breakpoint
CREATE TYPE "public"."alert_type" AS ENUM('follow', 'subscription', 'tip', 'raid');--> statement-breakpoint
CREATE TYPE "public"."appeal_kind" AS ENUM('integrity', 'moderation', 'dmca', 'account');--> statement-breakpoint
CREATE TYPE "public"."appeal_status" AS ENUM('open', 'upheld', 'overturned');--> statement-breakpoint
CREATE TYPE "public"."channel_role" AS ENUM('moderator', 'vip', 'editor');--> statement-breakpoint
CREATE TYPE "public"."clip_status" AS ENUM('processing', 'ready', 'failed', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."component_status" AS ENUM('operational', 'degraded', 'outage');--> statement-breakpoint
CREATE TYPE "public"."council_stance" AS ENUM('support', 'oppose', 'mixed', 'neutral');--> statement-breakpoint
CREATE TYPE "public"."deletion_status" AS ENUM('scheduled', 'canceled', 'completed');--> statement-breakpoint
CREATE TYPE "public"."delivery_source" AS ENUM('origin', 'relay', 'p2p', 'cdn');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."dispute_kind" AS ENUM('refund', 'chargeback');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('open', 'won', 'lost', 'closed');--> statement-breakpoint
CREATE TYPE "public"."dmca_status" AS ENUM('received', 'actioned', 'rejected', 'countered', 'restored');--> statement-breakpoint
CREATE TYPE "public"."election_status" AS ENUM('nominating', 'voting', 'closed');--> statement-breakpoint
CREATE TYPE "public"."event_transport" AS ENUM('webhook', 'websocket');--> statement-breakpoint
CREATE TYPE "public"."export_kind" AS ENUM('account', 'channel');--> statement-breakpoint
CREATE TYPE "public"."goal_type" AS ENUM('followers', 'subscriptions', 'tips');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('investigating', 'identified', 'monitoring', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."ingest_protocol" AS ENUM('rtmp', 'whip', 'srt', 'rtsp');--> statement-breakpoint
CREATE TYPE "public"."integrity_decision" AS ENUM('pending_review', 'excluded', 'allowed');--> statement-breakpoint
CREATE TYPE "public"."integrity_subject" AS ENUM('session', 'user', 'channel', 'relay', 'follow', 'chat_message', 'raid');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'ready', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."ledger_account_type" AS ENUM('asset', 'liability', 'equity', 'revenue', 'expense');--> statement-breakpoint
CREATE TYPE "public"."legal_document_kind" AS ENUM('terms', 'privacy', 'guidelines', 'cookies', 'dmca_policy');--> statement-breakpoint
CREATE TYPE "public"."member_class" AS ENUM('streamer', 'viewer', 'worker');--> statement-breakpoint
CREATE TYPE "public"."membership_basis" AS ENUM('streaming_hours', 'share', 'subscription', 'board_appointment');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('active', 'lapsed', 'exited');--> statement-breakpoint
CREATE TYPE "public"."mod_action" AS ENUM('ban', 'unban', 'timeout', 'untimeout', 'delete_message', 'clear_chat', 'slow_mode', 'followers_only', 'subscribers_only', 'emote_only', 'add_moderator', 'remove_moderator', 'add_vip', 'remove_vip', 'suspend_channel', 'unsuspend_channel', 'suspend_user', 'unsuspend_user', 'remove_content', 'restore_content');--> statement-breakpoint
CREATE TYPE "public"."mod_scope" AS ENUM('channel', 'platform');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('go_live', 'raid', 'proposal', 'vote_open', 'export_ready', 'payout', 'moderation', 'system');--> statement-breakpoint
CREATE TYPE "public"."patronage_status" AS ENUM('draft', 'computed', 'approved', 'distributed');--> statement-breakpoint
CREATE TYPE "public"."payment_kind" AS ENUM('subscription', 'tip', 'membership_share');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('manual', 'stripe');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded', 'charged_back');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('pending', 'scheduled', 'paid', 'failed', 'held');--> statement-breakpoint
CREATE TYPE "public"."platform_role" AS ENUM('user', 'moderator', 'admin', 'treasurer');--> statement-breakpoint
CREATE TYPE "public"."poll_status" AS ENUM('active', 'completed', 'terminated', 'archived');--> statement-breakpoint
CREATE TYPE "public"."prediction_status" AS ENUM('active', 'locked', 'resolved', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."proposal_kind" AS ENUM('ordinary', 'protected');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('draft', 'discussion', 'council_review', 'voting', 'passed', 'rejected', 'withdrawn', 'applied');--> statement-breakpoint
CREATE TYPE "public"."raid_status" AS ENUM('pending', 'completed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."receipt_status" AS ENUM('pending', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."relay_status" AS ENUM('pending', 'active', 'degraded', 'suspended', 'offline');--> statement-breakpoint
CREATE TYPE "public"."report_reason" AS ENUM('spam', 'harassment', 'hate', 'sexual_content', 'minor_safety', 'violence', 'self_harm', 'illegal', 'impersonation', 'copyright', 'unlabeled_mature', 'other');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'actioned', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."report_subject" AS ENUM('user', 'channel', 'chat_message', 'vod', 'clip', 'broadcast');--> statement-breakpoint
CREATE TYPE "public"."session_verdict" AS ENUM('pending', 'verified', 'excluded');--> statement-breakpoint
CREATE TYPE "public"."share_status" AS ENUM('pending', 'held', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."simulcast_platform" AS ENUM('twitch', 'youtube', 'custom');--> statement-breakpoint
CREATE TYPE "public"."simulcast_status" AS ENUM('idle', 'connecting', 'live', 'error', 'stopped');--> statement-breakpoint
CREATE TYPE "public"."song_request_status" AS ENUM('queued', 'played', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."event_subscription_state" AS ENUM('enabled', 'verification_pending', 'failed', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('incomplete', 'active', 'past_due', 'canceled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."user_level" AS ENUM('everyone', 'follower', 'subscriber', 'vip', 'moderator', 'broadcaster');--> statement-breakpoint
CREATE TYPE "public"."visibility" AS ENUM('public', 'subscribers', 'private');--> statement-breakpoint
CREATE TYPE "public"."vod_status" AS ENUM('recording', 'processing', 'ready', 'failed', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."vote_choice" AS ENUM('yes', 'no', 'abstain');--> statement-breakpoint
CREATE TYPE "public"."word_filter_action" AS ENUM('block', 'hold', 'replace');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"aaguid" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passkeys_credentialID_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"impersonated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "two_factors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	CONSTRAINT "two_factors_userId_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"username" text NOT NULL,
	"display_username" text,
	"role" "platform_role" DEFAULT 'user' NOT NULL,
	"banned" boolean DEFAULT false NOT NULL,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"two_factor_enabled" boolean DEFAULT false NOT NULL,
	"account_type" "account_type" DEFAULT 'human' NOT NULL,
	"bot_owner_id" uuid,
	"birth_date" date,
	"share_email_with_followed_channels" boolean DEFAULT false NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"deleted_at" timestamp with time zone,
	"pseudonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"box_art_key" text,
	"mature" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "channel_panels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"image_key" text,
	"link_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_roles" (
	"channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "channel_role" NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_roles_channel_id_user_id_role_pk" PRIMARY KEY("channel_id","user_id","role")
);
--> statement-breakpoint
CREATE TABLE "channel_sub_tiers" (
	"channel_id" uuid NOT NULL,
	"tier" smallint NOT NULL,
	"name" text NOT NULL,
	"price_cents" bigint NOT NULL,
	"benefits" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_sub_tiers_channel_id_tier_pk" PRIMARY KEY("channel_id","tier")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category_id" uuid,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"mature" boolean DEFAULT false NOT NULL,
	"theme" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"chat_settings" jsonb DEFAULT '{"slowModeSeconds":0,"followersOnlyMinutes":null,"subscribersOnly":false,"emoteOnly":false,"minAccountAgeDays":0,"requireVerifiedEmail":true,"linksAllowed":true}'::jsonb NOT NULL,
	"vod_enabled" boolean DEFAULT false NOT NULL,
	"vod_retention_days" integer DEFAULT 14 NOT NULL,
	"live_broadcast_id" uuid,
	"follower_count" integer DEFAULT 0 NOT NULL,
	"suspended_at" timestamp with time zone,
	"suspended_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_ownerId_unique" UNIQUE("owner_id")
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"follower_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"notify" boolean DEFAULT true NOT NULL,
	"excluded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_follower_id_channel_id_pk" PRIMARY KEY("follower_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stream_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_used_ip_hash" text,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stream_keys_keyHash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "broadcast_health_samples" (
	"broadcast_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"bitrate_kbps" integer NOT NULL,
	"fps" real,
	"width" integer,
	"height" integer,
	"video_codec" text,
	"audio_codec" text,
	"keyframe_interval_ms" integer,
	"dropped_frames" integer DEFAULT 0 NOT NULL,
	"warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "broadcast_health_samples_broadcast_id_at_pk" PRIMARY KEY("broadcast_id","at")
);
--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"stream_key_id" uuid,
	"ingest_protocol" "ingest_protocol" NOT NULL,
	"path" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"category_id" uuid,
	"mature" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"transcode_active" boolean DEFAULT false NOT NULL,
	"thumbnail_key" text,
	"peak_verified_viewers" integer DEFAULT 0 NOT NULL,
	"verified_viewer_seconds" bigint DEFAULT 0 NOT NULL,
	"excluded_viewer_seconds" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clips" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"broadcast_id" uuid,
	"vod_id" uuid,
	"creator_id" uuid,
	"title" text NOT NULL,
	"start_offset" double precision NOT NULL,
	"duration_seconds" double precision NOT NULL,
	"status" "clip_status" DEFAULT 'processing' NOT NULL,
	"storage_key" text,
	"thumbnail_key" text,
	"views" integer DEFAULT 0 NOT NULL,
	"removed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "egress_samples" (
	"broadcast_id" uuid NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"source" "delivery_source" NOT NULL,
	"bytes" bigint NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "egress_samples_broadcast_id_bucket_start_source_pk" PRIMARY KEY("broadcast_id","bucket_start","source")
);
--> statement-breakpoint
CREATE TABLE "hash_match_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"matched" boolean NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "simulcast_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"target_id" uuid NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"status" "simulcast_status" DEFAULT 'connecting' NOT NULL,
	"last_error" text,
	"bytes_sent" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "simulcast_targets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"platform" "simulcast_platform" NOT NULL,
	"name" text NOT NULL,
	"rtmp_url" text NOT NULL,
	"stream_key_ciphertext" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stream_hours" (
	"broadcast_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"hour_start" timestamp with time zone NOT NULL,
	"live_seconds" integer NOT NULL,
	"verified_other_viewers" integer DEFAULT 0 NOT NULL,
	"eligible" boolean DEFAULT false NOT NULL,
	CONSTRAINT "stream_hours_broadcast_id_hour_start_pk" PRIMARY KEY("broadcast_id","hour_start")
);
--> statement-breakpoint
CREATE TABLE "vods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "vod_status" DEFAULT 'recording' NOT NULL,
	"visibility" "visibility" DEFAULT 'public' NOT NULL,
	"storage_prefix" text NOT NULL,
	"duration_seconds" double precision DEFAULT 0 NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"thumbnail_key" text,
	"expires_at" timestamp with time zone,
	"removed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playback_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"broadcast_id" uuid,
	"user_id" uuid,
	"device_hash" text NOT NULL,
	"ip_hash" text NOT NULL,
	"asn" integer,
	"datacenter" text,
	"user_agent" text,
	"fingerprint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assigned_source" "delivery_source" DEFAULT 'origin' NOT NULL,
	"relay_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"heartbeats" integer DEFAULT 0 NOT NULL,
	"watch_seconds" integer DEFAULT 0 NOT NULL,
	"segments_fetched" integer DEFAULT 0 NOT NULL,
	"bytes_http" bigint DEFAULT 0 NOT NULL,
	"bytes_p_2p" bigint DEFAULT 0 NOT NULL,
	"stalls" integer DEFAULT 0 NOT NULL,
	"ttff_ms" integer,
	"latency_ms" double precision,
	"verdict" "session_verdict" DEFAULT 'pending' NOT NULL,
	"verdict_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"score" double precision,
	"scored_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "relay_issuance" (
	"relay_id" uuid NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"sessions" integer DEFAULT 0 NOT NULL,
	"segment_tokens" integer DEFAULT 0 NOT NULL,
	"bytes_issued" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "relay_issuance_relay_id_bucket_start_pk" PRIMARY KEY("relay_id","bucket_start")
);
--> statement-breakpoint
CREATE TABLE "relay_nodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"public_url" text NOT NULL,
	"region" text DEFAULT '' NOT NULL,
	"declared_capacity_mbps" integer NOT NULL,
	"public_key" text NOT NULL,
	"token_hash" text NOT NULL,
	"version" text,
	"status" "relay_status" DEFAULT 'pending' NOT NULL,
	"measured_capacity_mbps" integer,
	"last_health_at" timestamp with time zone,
	"last_health_latency_ms" integer,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"suspended_at" timestamp with time zone,
	"suspended_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_nodes_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "relay_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"relay_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"bytes_reported" bigint NOT NULL,
	"segments_reported" integer NOT NULL,
	"tokens_reported" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"signature" text NOT NULL,
	"status" "receipt_status" DEFAULT 'pending' NOT NULL,
	"bytes_verified" bigint DEFAULT 0 NOT NULL,
	"over_report_ratio" double precision,
	"checked_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_bans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"moderator_id" uuid,
	"reason" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone,
	"lifted_at" timestamp with time zone,
	"lifted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"broadcast_id" uuid,
	"user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"emotes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_action" boolean DEFAULT false NOT NULL,
	"reply_to_id" uuid,
	"via_app_id" uuid,
	"held_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emotes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid,
	"code" text NOT NULL,
	"image_key" text NOT NULL,
	"tier" smallint DEFAULT 0 NOT NULL,
	"animated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "word_filters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"pattern" text NOT NULL,
	"is_regex" boolean DEFAULT false NOT NULL,
	"action" "word_filter_action" DEFAULT 'block' NOT NULL,
	"replacement" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payment_id" uuid NOT NULL,
	"kind" "dispute_kind" NOT NULL,
	"status" "dispute_status" DEFAULT 'open' NOT NULL,
	"amount_cents" bigint NOT NULL,
	"provider_ref" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "infra_costs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"recorded_by" uuid,
	"ledger_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"attempts" smallint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_ref" text NOT NULL,
	"kind" "payment_kind" NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"user_id" uuid,
	"channel_id" uuid,
	"subscription_id" uuid,
	"tip_id" uuid,
	"amount_cents" bigint NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"fee_cents" bigint DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"refunded_cents" bigint DEFAULT 0 NOT NULL,
	"succeeded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_cents" > 0),
	CONSTRAINT "payments_currency_format" CHECK ("payments"."currency" ~ '^[a-z]{3}$'),
	CONSTRAINT "payments_refund_bounds" CHECK ("payments"."refunded_cents" >= 0 and "payments"."refunded_cents" <= "payments"."amount_cents")
);
--> statement-breakpoint
CREATE TABLE "payout_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_account_id" text,
	"payouts_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_accounts_userId_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" "payout_status" DEFAULT 'pending' NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_ref" text,
	"hold_reason" text,
	"ledger_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"tier" smallint NOT NULL,
	"status" "subscription_status" DEFAULT 'incomplete' NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_ref" text,
	"price_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"gifted_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tips" (
	"id" uuid PRIMARY KEY NOT NULL,
	"from_user_id" uuid,
	"channel_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"anonymous" boolean DEFAULT false NOT NULL,
	"payment_id" uuid,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"type" "ledger_account_type" NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" uuid,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_code_unique" UNIQUE("code"),
	CONSTRAINT "ledger_accounts_currency_format" CHECK ("ledger_accounts"."currency" ~ '^[a-z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_nonzero" CHECK ("ledger_entries"."amount_cents" <> 0),
	CONSTRAINT "ledger_entries_currency_format" CHECK ("ledger_entries"."currency" ~ '^[a-z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"ref_type" text,
	"ref_id" uuid,
	"idempotency_key" text NOT NULL,
	"reverses_id" uuid,
	"txid" bigint DEFAULT txid_current() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_transactions_idempotencyKey_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "board_seats" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"class" "member_class" NOT NULL,
	"election_id" uuid,
	"term_start" timestamp with time zone NOT NULL,
	"term_end" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "council_members" (
	"term_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"contribution_score" double precision NOT NULL,
	CONSTRAINT "council_members_term_id_user_id_pk" PRIMARY KEY("term_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "council_responses" (
	"proposal_id" uuid PRIMARY KEY NOT NULL,
	"term_id" uuid NOT NULL,
	"stance" "council_stance" NOT NULL,
	"body" text NOT NULL,
	"published_by_id" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "council_terms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"method" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "election_ballots" (
	"election_id" uuid NOT NULL,
	"voter_id" uuid NOT NULL,
	"candidate_ids" uuid[] NOT NULL,
	"cast_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "election_ballots_election_id_voter_id_pk" PRIMARY KEY("election_id","voter_id")
);
--> statement-breakpoint
CREATE TABLE "election_candidates" (
	"election_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"statement" text DEFAULT '' NOT NULL,
	"votes" integer DEFAULT 0 NOT NULL,
	"elected" boolean DEFAULT false NOT NULL,
	CONSTRAINT "election_candidates_election_id_user_id_pk" PRIMARY KEY("election_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "elections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"class" "member_class" NOT NULL,
	"seats" integer NOT NULL,
	"status" "election_status" DEFAULT 'nominating' NOT NULL,
	"nominations_close_at" timestamp with time zone NOT NULL,
	"voting_ends_at" timestamp with time zone NOT NULL,
	"term_months" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "governance_applications" (
	"proposal_id" uuid NOT NULL,
	"key" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "governance_applications_proposal_id_key_pk" PRIMARY KEY("proposal_id","key")
);
--> statement-breakpoint
CREATE TABLE "governance_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"protected" boolean NOT NULL,
	"description" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_proposal_id" uuid
);
--> statement-breakpoint
CREATE TABLE "governance_settings_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb NOT NULL,
	"proposal_id" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"membership_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"class" "member_class" NOT NULL,
	"status" "membership_status" NOT NULL,
	"basis" "membership_basis" NOT NULL,
	"op" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"payment_id" uuid,
	"status" "share_status" DEFAULT 'pending' NOT NULL,
	"purchased_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"class" "member_class" NOT NULL,
	"status" "membership_status" DEFAULT 'active' NOT NULL,
	"basis" "membership_basis" NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lapsed_at" timestamp with time zone,
	"exited_at" timestamp with time zone,
	"last_eligibility_check_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patronage_allocations" (
	"period_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"lines" jsonb NOT NULL,
	CONSTRAINT "patronage_allocations_period_id_user_id_pk" PRIMARY KEY("period_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "patronage_inputs" (
	"period_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"revenue_cents" bigint DEFAULT 0 NOT NULL,
	"eligible_streaming_hours" double precision DEFAULT 0 NOT NULL,
	"relay_bytes_verified" bigint DEFAULT 0 NOT NULL,
	"viewer_hours_verified" double precision DEFAULT 0 NOT NULL,
	"viewer_hours_excluded" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "patronage_inputs_period_id_user_id_pk" PRIMARY KEY("period_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "patronage_periods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" "patronage_status" DEFAULT 'draft' NOT NULL,
	"formula_version" text NOT NULL,
	"weights" jsonb NOT NULL,
	"surplus_cents" bigint DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"computed_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"approved_by_id" uuid,
	"ledger_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposal_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"proposal_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposal_electorate" (
	"proposal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"classes" "member_class"[] NOT NULL,
	CONSTRAINT "proposal_electorate_proposal_id_user_id_pk" PRIMARY KEY("proposal_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"author_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"kind" "proposal_kind" NOT NULL,
	"affects_creators" boolean NOT NULL,
	"status" "proposal_status" DEFAULT 'draft' NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rules" jsonb,
	"discussion_ends_at" timestamp with time zone,
	"council_review_started_at" timestamp with time zone,
	"council_review_ends_at" timestamp with time zone,
	"voting_starts_at" timestamp with time zone,
	"voting_ends_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tallies" (
	"proposal_id" uuid PRIMARY KEY NOT NULL,
	"breakdown" jsonb NOT NULL,
	"passed" boolean NOT NULL,
	"reason" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vote_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"proposal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"choice" "vote_choice" NOT NULL,
	"cast_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"proposal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"choice" "vote_choice" NOT NULL,
	"cast_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_deletions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "deletion_status" DEFAULT 'scheduled' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"pseudonym" text,
	"retained" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appeals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"appellant_id" uuid NOT NULL,
	"kind" "appeal_kind" NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"body" text NOT NULL,
	"status" "appeal_status" DEFAULT 'open' NOT NULL,
	"resolver_id" uuid,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"channel_id" uuid,
	"reason" text DEFAULT '' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"anonymous_id" text,
	"choices" jsonb NOT NULL,
	"policy_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_exports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "export_kind" NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"storage_key" text,
	"size_bytes" integer,
	"error" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dmca_counter_notices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"notice_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"address" text NOT NULL,
	"statement" text NOT NULL,
	"consent_to_jurisdiction" boolean NOT NULL,
	"signature" text NOT NULL,
	"restore_after" timestamp with time zone NOT NULL,
	"restored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dmca_notices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"claimant_name" text NOT NULL,
	"claimant_email" text NOT NULL,
	"claimant_address" text NOT NULL,
	"copyrighted_work" text NOT NULL,
	"infringing_urls" text[] NOT NULL,
	"subject_type" text,
	"subject_id" uuid,
	"good_faith_statement" boolean NOT NULL,
	"accuracy_statement" boolean NOT NULL,
	"signature" text NOT NULL,
	"status" "dmca_status" DEFAULT 'received' NOT NULL,
	"handled_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actioned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"status" "incident_status" DEFAULT 'investigating' NOT NULL,
	"components" text[] NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integrity_flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subject_type" "integrity_subject" NOT NULL,
	"subject_id" uuid NOT NULL,
	"channel_id" uuid,
	"signal" text NOT NULL,
	"score" double precision NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decision" "integrity_decision" DEFAULT 'pending_review' NOT NULL,
	"decided_by_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_acceptances" (
	"user_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_acceptances_user_id_document_id_pk" PRIMARY KEY("user_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "legal_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "legal_document_kind" NOT NULL,
	"version" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"is_draft" boolean DEFAULT true NOT NULL,
	"requires_acceptance" boolean DEFAULT true NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_holds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mod_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" "mod_scope" NOT NULL,
	"channel_id" uuid,
	"moderator_id" uuid,
	"target_user_id" uuid,
	"action" "mod_action" NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"duration_seconds" integer,
	"subject_type" text,
	"subject_id" uuid,
	"report_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reporter_id" uuid,
	"subject_type" "report_subject" NOT NULL,
	"subject_id" uuid NOT NULL,
	"channel_id" uuid,
	"reason" "report_reason" NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"assignee_id" uuid,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"app_id" uuid,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"version" text DEFAULT '1' NOT NULL,
	"condition" jsonb NOT NULL,
	"transport" "event_transport" NOT NULL,
	"callback_url" text,
	"secret_ciphertext" text,
	"websocket_session_id" text,
	"status" "event_subscription_state" DEFAULT 'verification_pending' NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_subscriptions_dedupe_uq" UNIQUE NULLS NOT DISTINCT("user_id","app_id","type","version","condition","transport","callback_url")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"version" text DEFAULT '1' NOT NULL,
	"channel_id" uuid,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_apps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_hash" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"confidential" boolean DEFAULT true NOT NULL,
	"secret_rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_apps_clientId_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"app_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"scopes" text[] NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"app_id" uuid,
	"user_id" uuid NOT NULL,
	"scopes" text[] NOT NULL,
	"access_token_hash" text NOT NULL,
	"refresh_token_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_tokens_accessTokenHash_unique" UNIQUE("access_token_hash"),
	CONSTRAINT "oauth_tokens_refreshTokenHash_unique" UNIQUE("refresh_token_hash")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subscription_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"message_type" text DEFAULT 'notification' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"response_status" integer,
	"response_body" text,
	"error" text,
	"latency_ms" integer,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_configs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"type" "alert_type" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"template" jsonb NOT NULL,
	"min_amount_cents" bigint DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 6000 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"response" text NOT NULL,
	"user_level" "user_level" DEFAULT 'everyone' NOT NULL,
	"cooldown_seconds" integer DEFAULT 5 NOT NULL,
	"cost_points" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_configs" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_timers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"name" text NOT NULL,
	"message" text NOT NULL,
	"interval_minutes" integer NOT NULL,
	"min_chat_lines" integer DEFAULT 5 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_fired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bot_variables" (
	"channel_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_variables_channel_id_name_pk" PRIMARY KEY("channel_id","name")
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"type" "goal_type" NOT NULL,
	"title" text NOT NULL,
	"target" bigint NOT NULL,
	"current" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "loyalty_balances" (
	"channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"points" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_balances_channel_id_user_id_pk" PRIMARY KEY("channel_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "loyalty_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"delta" bigint NOT NULL,
	"reason" text NOT NULL,
	"ref_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "overlay_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "overlay_tokens_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "poll_votes" (
	"poll_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"choice_id" text NOT NULL,
	"votes" integer DEFAULT 1 NOT NULL,
	"points_spent" integer DEFAULT 0 NOT NULL,
	"cast_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poll_votes_poll_id_user_id_pk" PRIMARY KEY("poll_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "polls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"title" text NOT NULL,
	"choices" jsonb NOT NULL,
	"status" "poll_status" DEFAULT 'active' NOT NULL,
	"duration_seconds" integer NOT NULL,
	"points_per_extra_vote" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "prediction_bets" (
	"prediction_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"outcome_id" text NOT NULL,
	"points" bigint NOT NULL,
	"payout" bigint,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prediction_bets_prediction_id_user_id_pk" PRIMARY KEY("prediction_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "predictions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"title" text NOT NULL,
	"outcomes" jsonb NOT NULL,
	"status" "prediction_status" DEFAULT 'active' NOT NULL,
	"window_seconds" integer NOT NULL,
	"winning_outcome_id" text,
	"created_by_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locks_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "raids" (
	"id" uuid PRIMARY KEY NOT NULL,
	"from_channel_id" uuid NOT NULL,
	"to_channel_id" uuid NOT NULL,
	"viewer_count" integer DEFAULT 0 NOT NULL,
	"status" "raid_status" DEFAULT 'pending' NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"execute_at" timestamp with time zone NOT NULL,
	"executed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "song_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"requester_id" uuid NOT NULL,
	"query" text NOT NULL,
	"status" "song_request_status" DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factors" ADD CONSTRAINT "two_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_bot_owner_id_users_id_fk" FOREIGN KEY ("bot_owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_panels" ADD CONSTRAINT "channel_panels_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_roles" ADD CONSTRAINT "channel_roles_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_roles" ADD CONSTRAINT "channel_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_roles" ADD CONSTRAINT "channel_roles_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_sub_tiers" ADD CONSTRAINT "channel_sub_tiers_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_keys" ADD CONSTRAINT "stream_keys_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_health_samples" ADD CONSTRAINT "broadcast_health_samples_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_vod_id_vods_id_fk" FOREIGN KEY ("vod_id") REFERENCES "public"."vods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_samples" ADD CONSTRAINT "egress_samples_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulcast_sessions" ADD CONSTRAINT "simulcast_sessions_target_id_simulcast_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."simulcast_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulcast_sessions" ADD CONSTRAINT "simulcast_sessions_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulcast_targets" ADD CONSTRAINT "simulcast_targets_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_hours" ADD CONSTRAINT "stream_hours_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_hours" ADD CONSTRAINT "stream_hours_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vods" ADD CONSTRAINT "vods_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vods" ADD CONSTRAINT "vods_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_sessions" ADD CONSTRAINT "playback_sessions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_sessions" ADD CONSTRAINT "playback_sessions_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_sessions" ADD CONSTRAINT "playback_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_sessions" ADD CONSTRAINT "playback_sessions_relay_id_relay_nodes_id_fk" FOREIGN KEY ("relay_id") REFERENCES "public"."relay_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_issuance" ADD CONSTRAINT "relay_issuance_relay_id_relay_nodes_id_fk" FOREIGN KEY ("relay_id") REFERENCES "public"."relay_nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_nodes" ADD CONSTRAINT "relay_nodes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_receipts" ADD CONSTRAINT "relay_receipts_relay_id_relay_nodes_id_fk" FOREIGN KEY ("relay_id") REFERENCES "public"."relay_nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_bans" ADD CONSTRAINT "chat_bans_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_bans" ADD CONSTRAINT "chat_bans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_bans" ADD CONSTRAINT "chat_bans_moderator_id_users_id_fk" FOREIGN KEY ("moderator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emotes" ADD CONSTRAINT "emotes_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "word_filters" ADD CONSTRAINT "word_filters_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_costs" ADD CONSTRAINT "infra_costs_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tip_id_tips_id_fk" FOREIGN KEY ("tip_id") REFERENCES "public"."tips"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_subscriber_id_users_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_gifted_by_id_users_id_fk" FOREIGN KEY ("gifted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_reverses_id_ledger_transactions_id_fk" FOREIGN KEY ("reverses_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_seats" ADD CONSTRAINT "board_seats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_seats" ADD CONSTRAINT "board_seats_election_id_elections_id_fk" FOREIGN KEY ("election_id") REFERENCES "public"."elections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "council_members" ADD CONSTRAINT "council_members_term_id_council_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."council_terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "council_members" ADD CONSTRAINT "council_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "council_responses" ADD CONSTRAINT "council_responses_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "council_responses" ADD CONSTRAINT "council_responses_term_id_council_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."council_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "council_responses" ADD CONSTRAINT "council_responses_published_by_id_users_id_fk" FOREIGN KEY ("published_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "election_ballots" ADD CONSTRAINT "election_ballots_election_id_elections_id_fk" FOREIGN KEY ("election_id") REFERENCES "public"."elections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "election_ballots" ADD CONSTRAINT "election_ballots_voter_id_users_id_fk" FOREIGN KEY ("voter_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "election_candidates" ADD CONSTRAINT "election_candidates_election_id_elections_id_fk" FOREIGN KEY ("election_id") REFERENCES "public"."elections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "election_candidates" ADD CONSTRAINT "election_candidates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_applications" ADD CONSTRAINT "governance_applications_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_settings" ADD CONSTRAINT "governance_settings_updated_by_proposal_id_proposals_id_fk" FOREIGN KEY ("updated_by_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_shares" ADD CONSTRAINT "membership_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patronage_allocations" ADD CONSTRAINT "patronage_allocations_period_id_patronage_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."patronage_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patronage_allocations" ADD CONSTRAINT "patronage_allocations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patronage_inputs" ADD CONSTRAINT "patronage_inputs_period_id_patronage_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."patronage_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patronage_inputs" ADD CONSTRAINT "patronage_inputs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_comments" ADD CONSTRAINT "proposal_comments_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_comments" ADD CONSTRAINT "proposal_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_electorate" ADD CONSTRAINT "proposal_electorate_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_electorate" ADD CONSTRAINT "proposal_electorate_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tallies" ADD CONSTRAINT "tallies_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_appellant_id_users_id_fk" FOREIGN KEY ("appellant_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmca_counter_notices" ADD CONSTRAINT "dmca_counter_notices_notice_id_dmca_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."dmca_notices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmca_counter_notices" ADD CONSTRAINT "dmca_counter_notices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrity_flags" ADD CONSTRAINT "integrity_flags_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_document_id_legal_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."legal_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mod_actions" ADD CONSTRAINT "mod_actions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mod_actions" ADD CONSTRAINT "mod_actions_moderator_id_users_id_fk" FOREIGN KEY ("moderator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mod_actions" ADD CONSTRAINT "mod_actions_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_subscriptions" ADD CONSTRAINT "event_subscriptions_app_id_oauth_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."oauth_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_subscriptions" ADD CONSTRAINT "event_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_apps" ADD CONSTRAINT "oauth_apps_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_app_id_oauth_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."oauth_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_app_id_oauth_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."oauth_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_event_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."event_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_configs" ADD CONSTRAINT "alert_configs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_commands" ADD CONSTRAINT "bot_commands_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD CONSTRAINT "bot_configs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_timers" ADD CONSTRAINT "bot_timers_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_variables" ADD CONSTRAINT "bot_variables_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_balances" ADD CONSTRAINT "loyalty_balances_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_balances" ADD CONSTRAINT "loyalty_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overlay_tokens" ADD CONSTRAINT "overlay_tokens_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_bets" ADD CONSTRAINT "prediction_bets_prediction_id_predictions_id_fk" FOREIGN KEY ("prediction_id") REFERENCES "public"."predictions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_bets" ADD CONSTRAINT "prediction_bets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raids" ADD CONSTRAINT "raids_from_channel_id_channels_id_fk" FOREIGN KEY ("from_channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raids" ADD CONSTRAINT "raids_to_channel_id_channels_id_fk" FOREIGN KEY ("to_channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "song_requests" ADD CONSTRAINT "song_requests_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "song_requests" ADD CONSTRAINT "song_requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_uq" ON "accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "passkeys_user_idx" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_uq" ON "users" USING btree ("username");--> statement-breakpoint
CREATE INDEX "users_bot_owner_idx" ON "users" USING btree ("bot_owner_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "channel_panels_channel_idx" ON "channel_panels" USING btree ("channel_id","position");--> statement-breakpoint
CREATE INDEX "channel_roles_user_idx" ON "channel_roles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_slug_uq" ON "channels" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "channels_live_idx" ON "channels" USING btree ("live_broadcast_id") WHERE "channels"."live_broadcast_id" is not null;--> statement-breakpoint
CREATE INDEX "channels_category_idx" ON "channels" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "channels_search_idx" ON "channels" USING gin (to_tsvector('simple', "display_name" || ' ' || "title" || ' ' || "description"));--> statement-breakpoint
CREATE INDEX "follows_channel_idx" ON "follows" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "stream_keys_channel_idx" ON "stream_keys" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "broadcasts_channel_idx" ON "broadcasts" USING btree ("channel_id","started_at");--> statement-breakpoint
CREATE INDEX "broadcasts_live_idx" ON "broadcasts" USING btree ("channel_id") WHERE "broadcasts"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "clips_channel_idx" ON "clips" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "egress_samples_bucket_idx" ON "egress_samples" USING btree ("bucket_start");--> statement-breakpoint
CREATE INDEX "hash_match_subject_idx" ON "hash_match_results" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "simulcast_sessions_broadcast_idx" ON "simulcast_sessions" USING btree ("broadcast_id");--> statement-breakpoint
CREATE INDEX "simulcast_targets_channel_idx" ON "simulcast_targets" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "stream_hours_channel_idx" ON "stream_hours" USING btree ("channel_id","hour_start");--> statement-breakpoint
CREATE INDEX "vods_channel_idx" ON "vods" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "vods_expiry_idx" ON "vods" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "playback_sessions_broadcast_idx" ON "playback_sessions" USING btree ("broadcast_id","verdict");--> statement-breakpoint
CREATE INDEX "playback_sessions_active_idx" ON "playback_sessions" USING btree ("channel_id") WHERE "playback_sessions"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "playback_sessions_device_idx" ON "playback_sessions" USING btree ("device_hash","started_at");--> statement-breakpoint
CREATE INDEX "playback_sessions_user_idx" ON "playback_sessions" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "playback_sessions_relay_idx" ON "playback_sessions" USING btree ("relay_id","started_at");--> statement-breakpoint
CREATE INDEX "relay_nodes_owner_idx" ON "relay_nodes" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "relay_nodes_status_idx" ON "relay_nodes" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "relay_receipts_nonce_uq" ON "relay_receipts" USING btree ("relay_id","nonce");--> statement-breakpoint
CREATE INDEX "relay_receipts_period_idx" ON "relay_receipts" USING btree ("relay_id","period_start");--> statement-breakpoint
CREATE INDEX "relay_receipts_status_idx" ON "relay_receipts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "chat_bans_lookup_idx" ON "chat_bans" USING btree ("channel_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_bans_active_uq" ON "chat_bans" USING btree ("channel_id","user_id") WHERE "chat_bans"."lifted_at" is null;--> statement-breakpoint
CREATE INDEX "chat_messages_channel_idx" ON "chat_messages" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_messages_user_idx" ON "chat_messages" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "emotes_code_uq" ON "emotes" USING btree (coalesce("channel_id", '00000000-0000-0000-0000-000000000000'::uuid),"code");--> statement-breakpoint
CREATE INDEX "word_filters_channel_idx" ON "word_filters" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "disputes_payment_idx" ON "disputes" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "infra_costs_period_idx" ON "infra_costs" USING btree ("period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_uq" ON "payment_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_ref_uq" ON "payments" USING btree ("provider","provider_ref");--> statement-breakpoint
CREATE INDEX "payments_channel_idx" ON "payments" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "payouts_user_idx" ON "payouts" USING btree ("user_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_period_uq" ON "payouts" USING btree ("user_id","period_start");--> statement-breakpoint
CREATE INDEX "subscriptions_channel_idx" ON "subscriptions" USING btree ("channel_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_active_uq" ON "subscriptions" USING btree ("subscriber_id","channel_id") WHERE "subscriptions"."status" in ('active', 'past_due', 'incomplete');--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_provider_ref_uq" ON "subscriptions" USING btree ("provider","provider_ref");--> statement-breakpoint
CREATE INDEX "tips_channel_idx" ON "tips" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_accounts_owner_idx" ON "ledger_accounts" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_tx_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_transactions_ref_idx" ON "ledger_transactions" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "ledger_transactions_time_idx" ON "ledger_transactions" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "board_seats_term_idx" ON "board_seats" USING btree ("term_end");--> statement-breakpoint
CREATE INDEX "governance_settings_history_key_idx" ON "governance_settings_history" USING btree ("key","changed_at");--> statement-breakpoint
CREATE INDEX "membership_history_user_idx" ON "membership_history" USING btree ("user_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_shares_held_uq" ON "membership_shares" USING btree ("user_id") WHERE "membership_shares"."status" in ('pending', 'held');--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_active_uq" ON "memberships" USING btree ("user_id","class") WHERE "memberships"."status" = 'active';--> statement-breakpoint
CREATE INDEX "memberships_class_idx" ON "memberships" USING btree ("class","status");--> statement-breakpoint
CREATE UNIQUE INDEX "patronage_periods_uq" ON "patronage_periods" USING btree ("period_start","period_end");--> statement-breakpoint
CREATE INDEX "proposal_comments_proposal_idx" ON "proposal_comments" USING btree ("proposal_id","created_at");--> statement-breakpoint
CREATE INDEX "proposals_status_idx" ON "proposals" USING btree ("status","voting_ends_at");--> statement-breakpoint
CREATE INDEX "vote_history_proposal_idx" ON "vote_history" USING btree ("proposal_id","cast_at");--> statement-breakpoint
CREATE UNIQUE INDEX "votes_one_per_member_uq" ON "votes" USING btree ("proposal_id","user_id");--> statement-breakpoint
CREATE INDEX "account_deletions_due_idx" ON "account_deletions" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "appeals_queue_idx" ON "appeals" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "appeals_open_uq" ON "appeals" USING btree ("appellant_id","subject_type","subject_id") WHERE "appeals"."status" = 'open';--> statement-breakpoint
CREATE INDEX "audit_log_subject_idx" ON "audit_log" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "audit_log_channel_idx" ON "audit_log" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "consent_records_user_idx" ON "consent_records" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "consent_records_anon_idx" ON "consent_records" USING btree ("anonymous_id");--> statement-breakpoint
CREATE INDEX "data_exports_user_idx" ON "data_exports" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "dmca_notices_status_idx" ON "dmca_notices" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "integrity_flags_subject_idx" ON "integrity_flags" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "integrity_flags_channel_idx" ON "integrity_flags" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_documents_version_uq" ON "legal_documents" USING btree ("kind","version");--> statement-breakpoint
CREATE INDEX "mod_actions_channel_idx" ON "mod_actions" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "mod_actions_target_idx" ON "mod_actions" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "reports_queue_idx" ON "reports" USING btree ("status","priority","created_at");--> statement-breakpoint
CREATE INDEX "event_subscriptions_type_idx" ON "event_subscriptions" USING btree ("type","status");--> statement-breakpoint
CREATE INDEX "events_unpublished_idx" ON "events" USING btree ("occurred_at") WHERE "events"."published_at" is null;--> statement-breakpoint
CREATE INDEX "events_channel_type_idx" ON "events" USING btree ("channel_id","type","occurred_at");--> statement-breakpoint
CREATE INDEX "oauth_apps_owner_idx" ON "oauth_apps" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "oauth_tokens_user_idx" ON "oauth_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_tokens_app_idx" ON "oauth_tokens" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_sub_idx" ON "webhook_deliveries" USING btree ("subscription_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_configs_uq" ON "alert_configs" USING btree ("channel_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_commands_name_uq" ON "bot_commands" USING btree ("channel_id","name");--> statement-breakpoint
CREATE INDEX "bot_timers_channel_idx" ON "bot_timers" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "goals_channel_idx" ON "goals" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "loyalty_tx_user_idx" ON "loyalty_transactions" USING btree ("channel_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "polls_channel_idx" ON "polls" USING btree ("channel_id","started_at");--> statement-breakpoint
CREATE INDEX "predictions_channel_idx" ON "predictions" USING btree ("channel_id","started_at");--> statement-breakpoint
CREATE INDEX "raids_to_idx" ON "raids" USING btree ("to_channel_id","created_at");--> statement-breakpoint
CREATE INDEX "song_requests_channel_idx" ON "song_requests" USING btree ("channel_id","status","created_at");