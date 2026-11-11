CREATE TYPE "public"."notification_preference_type" AS ENUM('go_live', 'governance', 'payout', 'creator', 'digest_weekly');--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'report_outcome';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'moderator_added';--> statement-breakpoint
CREATE TABLE "transparency_notes" (
	"month" text PRIMARY KEY NOT NULL,
	"body" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transparency_notes_month_format" CHECK ("transparency_notes"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "transparency_notes_body_length" CHECK (char_length("transparency_notes"."body") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "notification_digest_sends" (
	"user_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_digest_sends_user_id_week_start_pk" PRIMARY KEY("user_id","week_start")
);
--> statement-breakpoint
ALTER TABLE "channel_setup_steps" DROP CONSTRAINT "channel_setup_steps_step";--> statement-breakpoint
-- Governance email-off rows were stored per notification type (`proposal`, `vote_open`). Keep one
-- `governance` row per member, channel and medium (off wins), and drop rows of any type that has no
-- preference (none are written today).
DELETE FROM "notification_preferences" WHERE "type"::text NOT IN ('go_live', 'proposal', 'vote_open');--> statement-breakpoint
UPDATE "notification_preferences" p SET "enabled" = p."enabled" AND q."enabled"
  FROM "notification_preferences" q
  WHERE p."type" = 'proposal' AND q."type" = 'vote_open' AND q."user_id" = p."user_id"
    AND q."medium" = p."medium" AND q."channel_id" IS NOT DISTINCT FROM p."channel_id";--> statement-breakpoint
DELETE FROM "notification_preferences" p USING "notification_preferences" q
  WHERE p."type" = 'vote_open' AND q."type" = 'proposal' AND q."user_id" = p."user_id"
    AND q."medium" = p."medium" AND q."channel_id" IS NOT DISTINCT FROM p."channel_id";--> statement-breakpoint
ALTER TABLE "notification_preferences" ALTER COLUMN "type" SET DATA TYPE "public"."notification_preference_type"
  USING (CASE WHEN "type"::text IN ('proposal', 'vote_open') THEN 'governance' ELSE "type"::text END)::"public"."notification_preference_type";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "first_notify_optin_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD COLUMN "assignee_id" uuid;--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transparency_notes" ADD CONSTRAINT "transparency_notes_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_digest_sends" ADD CONSTRAINT "notification_digest_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderation_cases_assignee_idx" ON "moderation_cases" USING btree ("assignee_id") WHERE "moderation_cases"."assignee_id" is not null;--> statement-breakpoint
ALTER TABLE "channel_setup_steps" ADD CONSTRAINT "channel_setup_steps_step" CHECK ("channel_setup_steps"."step" IN ('bring_your_audience', 'get_paid'));