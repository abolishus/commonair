CREATE TYPE "public"."payment_fraud_decision" AS ENUM('clear', 'confirm');--> statement-breakpoint
CREATE TYPE "public"."payment_fraud_kind" AS ENUM('payer_velocity', 'payer_concentration', 'new_payee', 'manual');--> statement-breakpoint
CREATE TYPE "public"."payment_fraud_status" AS ENUM('open', 'reviewed', 'cleared', 'confirmed');--> statement-breakpoint
ALTER TYPE "public"."report_subject" ADD VALUE 'message_set';--> statement-breakpoint
CREATE TABLE "user_blocks" (
	"user_id" uuid NOT NULL,
	"blocked_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_blocks_user_id_blocked_user_id_pk" PRIMARY KEY("user_id","blocked_user_id"),
	CONSTRAINT "user_blocks_not_self" CHECK ("user_blocks"."user_id" <> "user_blocks"."blocked_user_id")
);
--> statement-breakpoint
CREATE TABLE "payment_fraud_flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payee_user_id" uuid NOT NULL,
	"kind" "payment_fraud_kind" NOT NULL,
	"status" "payment_fraud_status" DEFAULT 'open' NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raised_by_id" uuid,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by_id" uuid,
	"recommendation" "payment_fraud_decision",
	"reviewed_at" timestamp with time zone,
	"decided_by_id" uuid,
	"decision" "payment_fraud_decision",
	"decided_at" timestamp with time zone,
	"released_by_id" uuid,
	"released_at" timestamp with time zone,
	"note" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "chat_settings" SET DEFAULT '{"slowModeSeconds":0,"followersOnlyMinutes":null,"subscribersOnly":false,"emoteOnly":false,"minAccountAgeDays":0,"requireVerifiedEmail":true,"linksAllowed":true,"minVerifiedWatchSeconds":0,"verifiedWatchExemptSubscribers":true,"surgeGuard":{"enabled":false,"triggerUnverifiedRatio":0.5,"cooldownMinutes":10}}'::jsonb;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "media_ts" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_user_id_users_id_fk" FOREIGN KEY ("blocked_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_fraud_flags" ADD CONSTRAINT "payment_fraud_flags_payee_user_id_users_id_fk" FOREIGN KEY ("payee_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_fraud_flags" ADD CONSTRAINT "payment_fraud_flags_raised_by_id_users_id_fk" FOREIGN KEY ("raised_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_fraud_flags" ADD CONSTRAINT "payment_fraud_flags_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_fraud_flags" ADD CONSTRAINT "payment_fraud_flags_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_fraud_flags" ADD CONSTRAINT "payment_fraud_flags_released_by_id_users_id_fk" FOREIGN KEY ("released_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_blocks_blocked_idx" ON "user_blocks" USING btree ("blocked_user_id");--> statement-breakpoint
CREATE INDEX "payment_fraud_flags_payee_idx" ON "payment_fraud_flags" USING btree ("payee_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_fraud_flags_open_uq" ON "payment_fraud_flags" USING btree ("payee_user_id","kind") WHERE status in ('open', 'reviewed');--> statement-breakpoint
CREATE INDEX "chat_messages_broadcast_media_idx" ON "chat_messages" USING btree ("broadcast_id","media_ts");--> statement-breakpoint
CREATE INDEX "chat_messages_created_idx" ON "chat_messages" USING btree ("created_at");