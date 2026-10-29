CREATE TYPE "public"."app_suspension_reason" AS ENUM('abuse', 'spam', 'security', 'terms_violation', 'impersonation', 'other');--> statement-breakpoint
CREATE TYPE "public"."oauth_device_code_status" AS ENUM('pending', 'approved', 'denied', 'redeemed');--> statement-breakpoint
CREATE TYPE "public"."oauth_token_kind" AS ENUM('personal', 'authorization_code', 'device_code', 'client_credentials');--> statement-breakpoint
CREATE TABLE "oauth_device_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"app_id" uuid NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"status" "oauth_device_code_status" DEFAULT 'pending' NOT NULL,
	"user_id" uuid,
	"interval_seconds" integer DEFAULT 5 NOT NULL,
	"last_polled_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_device_codes_deviceCodeHash_unique" UNIQUE("device_code_hash"),
	CONSTRAINT "oauth_device_codes_decided_ck" CHECK (("oauth_device_codes"."status" = 'pending') = ("oauth_device_codes"."decided_at" is null)),
	CONSTRAINT "oauth_device_codes_user_ck" CHECK (("oauth_device_codes"."status" = 'pending') = ("oauth_device_codes"."user_id" is null))
);
--> statement-breakpoint
ALTER TABLE "event_subscriptions" DROP CONSTRAINT "event_subscriptions_dedupe_uq";--> statement-breakpoint
DROP INDEX "oauth_tokens_app_idx";--> statement-breakpoint
ALTER TABLE "oauth_apps" ALTER COLUMN "client_secret_hash" DROP NOT NULL;--> statement-breakpoint
DELETE FROM "oauth_codes";--> statement-breakpoint
ALTER TABLE "oauth_codes" ALTER COLUMN "code_challenge" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_apps" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_apps" ADD COLUMN "suspended_reason" "app_suspension_reason";--> statement-breakpoint
ALTER TABLE "oauth_apps" ADD COLUMN "suspended_by_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD COLUMN "code_challenge_method" text DEFAULT 'S256' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD COLUMN "redeemed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD COLUMN "family_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD COLUMN "kind" "oauth_token_kind" DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD COLUMN "refresh_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD COLUMN "family_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD COLUMN "rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_device_codes" ADD CONSTRAINT "oauth_device_codes_app_id_oauth_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."oauth_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_device_codes" ADD CONSTRAINT "oauth_device_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_device_codes_user_code_uq" ON "oauth_device_codes" USING btree ("user_code_hash");--> statement-breakpoint
CREATE INDEX "oauth_device_codes_expires_idx" ON "oauth_device_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "event_subscriptions_app_user_idx" ON "event_subscriptions" USING btree ("app_id","user_id");--> statement-breakpoint
CREATE INDEX "event_subscriptions_ws_session_idx" ON "event_subscriptions" USING btree ("websocket_session_id") WHERE "event_subscriptions"."websocket_session_id" is not null;--> statement-breakpoint
CREATE INDEX "oauth_codes_expires_idx" ON "oauth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_tokens_app_user_idx" ON "oauth_tokens" USING btree ("app_id","user_id");--> statement-breakpoint
CREATE INDEX "oauth_tokens_family_idx" ON "oauth_tokens" USING btree ("family_id");--> statement-breakpoint
ALTER TABLE "event_subscriptions" ADD CONSTRAINT "event_subscriptions_dedupe_uq" UNIQUE NULLS NOT DISTINCT("user_id","app_id","type","version","condition","transport","callback_url","websocket_session_id");--> statement-breakpoint
ALTER TABLE "event_subscriptions" ADD CONSTRAINT "event_subscriptions_transport_ck" CHECK (("event_subscriptions"."transport" = 'webhook') = ("event_subscriptions"."callback_url" is not null and "event_subscriptions"."secret_ciphertext" is not null) and ("event_subscriptions"."transport" = 'websocket') = ("event_subscriptions"."websocket_session_id" is not null));--> statement-breakpoint
ALTER TABLE "oauth_apps" ADD CONSTRAINT "oauth_apps_secret_ck" CHECK ("oauth_apps"."confidential" = ("oauth_apps"."client_secret_hash" is not null));--> statement-breakpoint
ALTER TABLE "oauth_apps" ADD CONSTRAINT "oauth_apps_suspension_ck" CHECK (("oauth_apps"."suspended_at" is null) = ("oauth_apps"."suspended_reason" is null) and ("oauth_apps"."suspended_at" is null) = ("oauth_apps"."suspended_by_id" is null));--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_s256_ck" CHECK ("oauth_codes"."code_challenge_method" = 'S256');--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_redeemed_ck" CHECK (("oauth_codes"."redeemed_at" is null) = ("oauth_codes"."family_id" is null));--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_app_only_ck" CHECK (("oauth_tokens"."user_id" is null) = ("oauth_tokens"."kind" = 'client_credentials') and ("oauth_tokens"."user_id" is not null or ("oauth_tokens"."refresh_token_hash" is null and cardinality("oauth_tokens"."scopes") = 0)));--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_family_ck" CHECK (("oauth_tokens"."refresh_token_hash" is null) = ("oauth_tokens"."family_id" is null));--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_refresh_expiry_ck" CHECK (("oauth_tokens"."refresh_token_hash" is null) = ("oauth_tokens"."refresh_expires_at" is null));--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_personal_ck" CHECK (("oauth_tokens"."kind" = 'personal') = ("oauth_tokens"."app_id" is null));