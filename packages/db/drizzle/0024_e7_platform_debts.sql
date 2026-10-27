CREATE TYPE "public"."account_action" AS ENUM('dmca_strike', 'dmca_termination');--> statement-breakpoint
CREATE TYPE "public"."account_action_reversal" AS ENUM('appeal_overturned', 'counter_notice_restored', 'strikes_below_threshold');--> statement-breakpoint
CREATE TYPE "public"."dmca_item_subject" AS ENUM('vod', 'clip', 'broadcast');--> statement-breakpoint
CREATE TABLE "account_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"action" "account_action" NOT NULL,
	"source_type" text,
	"source_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by_id" uuid,
	"reversed_reason" "account_action_reversal",
	"reversal_appeal_id" uuid,
	CONSTRAINT "account_actions_reversal_ck" CHECK (("account_actions"."reversed_at" is null) = ("account_actions"."reversed_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "dmca_notice_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"notice_id" uuid NOT NULL,
	"url" text NOT NULL,
	"subject_type" "dmca_item_subject",
	"subject_id" uuid,
	"owner_id" uuid,
	"channel_id" uuid,
	"removed_at" timestamp with time zone,
	"objects_hidden_at" timestamp with time zone,
	"restored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dmca_counter_notices" ADD COLUMN "phone" text NOT NULL;--> statement-breakpoint
ALTER TABLE "dmca_counter_notices" ADD COLUMN "item_ids" uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "dmca_counter_notices" ADD COLUMN "good_faith_statement" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "dmca_counter_notices" ADD COLUMN "suit_filed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dmca_counter_notices" ADD COLUMN "suit_recorded_by_id" uuid;--> statement-breakpoint
ALTER TABLE "dmca_counter_notices" ADD COLUMN "suit_note" text;--> statement-breakpoint
ALTER TABLE "dmca_notices" ADD COLUMN "claimant_phone" text;--> statement-breakpoint
ALTER TABLE "dmca_notices" ADD COLUMN "decision_note" text;--> statement-breakpoint
ALTER TABLE "account_actions" ADD CONSTRAINT "account_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmca_notice_items" ADD CONSTRAINT "dmca_notice_items_notice_id_dmca_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."dmca_notices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmca_notice_items" ADD CONSTRAINT "dmca_notice_items_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmca_notice_items" ADD CONSTRAINT "dmca_notice_items_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_actions_user_idx" ON "account_actions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "account_actions_source_idx" ON "account_actions" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "account_actions_active_idx" ON "account_actions" USING btree ("user_id","action") WHERE "account_actions"."reversed_at" is null;--> statement-breakpoint
CREATE INDEX "dmca_notice_items_notice_idx" ON "dmca_notice_items" USING btree ("notice_id");--> statement-breakpoint
CREATE INDEX "dmca_notice_items_owner_idx" ON "dmca_notice_items" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "dmca_notice_items_subject_idx" ON "dmca_notice_items" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "clips_broadcast_idx" ON "clips" USING btree ("broadcast_id");--> statement-breakpoint
CREATE INDEX "consent_records_anon_created_idx" ON "consent_records" USING btree ("created_at") WHERE "consent_records"."user_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "dmca_counter_notices_notice_user_uq" ON "dmca_counter_notices" USING btree ("notice_id","user_id");--> statement-breakpoint
CREATE INDEX "dmca_counter_notices_due_idx" ON "dmca_counter_notices" USING btree ("restore_after") WHERE "dmca_counter_notices"."restored_at" is null and "dmca_counter_notices"."suit_filed_at" is null;--> statement-breakpoint
ALTER TABLE "dmca_notices" DROP COLUMN "subject_type";--> statement-breakpoint
ALTER TABLE "dmca_notices" DROP COLUMN "subject_id";