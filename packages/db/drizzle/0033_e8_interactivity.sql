CREATE TYPE "public"."loyalty_reason" AS ENUM('watch', 'command', 'prediction_bet', 'prediction_payout', 'prediction_refund', 'poll_vote', 'moderator_adjust');--> statement-breakpoint
CREATE TYPE "public"."raid_cancel_reason" AS ENUM('owner', 'target_offline', 'target_refused', 'suspended', 'source_offline');--> statement-breakpoint
CREATE TYPE "public"."raid_policy" AS ENUM('anyone', 'followed', 'off');--> statement-breakpoint
CREATE TABLE "loyalty_accrual_sessions" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"counted_seconds" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loyalty_accruals" (
	"channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"carry_seconds" integer DEFAULT 0 NOT NULL,
	"day" date NOT NULL,
	"day_points" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_accruals_channel_id_user_id_pk" PRIMARY KEY("channel_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "song_requests" RENAME COLUMN "query" TO "url";--> statement-breakpoint
ALTER TABLE "loyalty_balances" DROP CONSTRAINT "loyalty_balances_channel_id_channels_id_fk";
--> statement-breakpoint
ALTER TABLE "loyalty_balances" DROP CONSTRAINT "loyalty_balances_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "loyalty_transactions" DROP CONSTRAINT "loyalty_transactions_channel_id_channels_id_fk";
--> statement-breakpoint
ALTER TABLE "loyalty_transactions" DROP CONSTRAINT "loyalty_transactions_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "bot_configs" ALTER COLUMN "enabled" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ALTER COLUMN "reason" SET DATA TYPE "public"."loyalty_reason" USING "reason"::"public"."loyalty_reason";--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "raid_policy" "raid_policy" DEFAULT 'anyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "bot_user_id" uuid;--> statement-breakpoint
ALTER TABLE "polls" ADD COLUMN "changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "polls" ADD COLUMN "progress_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "progress_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "raids" ADD COLUMN "canceled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "raids" ADD COLUMN "cancel_reason" "raid_cancel_reason";--> statement-breakpoint
ALTER TABLE "loyalty_accrual_sessions" ADD CONSTRAINT "loyalty_accrual_sessions_session_id_playback_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."playback_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_accruals" ADD CONSTRAINT "loyalty_accruals_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_accruals" ADD CONSTRAINT "loyalty_accruals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD CONSTRAINT "bot_configs_bot_user_id_users_id_fk" FOREIGN KEY ("bot_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_balances" ADD CONSTRAINT "loyalty_balances_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_balances" ADD CONSTRAINT "loyalty_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playback_sessions_points_idx" ON "playback_sessions" USING btree ("scored_at") WHERE "playback_sessions"."user_id" is not null and "playback_sessions"."verdict" = 'verified';--> statement-breakpoint
CREATE UNIQUE INDEX "goals_channel_open_uq" ON "goals" USING btree ("channel_id","type") WHERE "goals"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "loyalty_balances_leaderboard_idx" ON "loyalty_balances" USING btree ("channel_id","points");--> statement-breakpoint
CREATE UNIQUE INDEX "polls_channel_active_uq" ON "polls" USING btree ("channel_id") WHERE "polls"."status" = 'active';--> statement-breakpoint
CREATE INDEX "polls_due_idx" ON "polls" USING btree ("ends_at") WHERE "polls"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "predictions_channel_open_uq" ON "predictions" USING btree ("channel_id") WHERE "predictions"."status" in ('active', 'locked');--> statement-breakpoint
CREATE INDEX "predictions_due_idx" ON "predictions" USING btree ("locks_at") WHERE "predictions"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "raids_from_pending_uq" ON "raids" USING btree ("from_channel_id") WHERE "raids"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "raids_from_idx" ON "raids" USING btree ("from_channel_id","created_at");--> statement-breakpoint
CREATE INDEX "raids_due_idx" ON "raids" USING btree ("execute_at") WHERE "raids"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "song_requests_requester_idx" ON "song_requests" USING btree ("channel_id","requester_id","status");--> statement-breakpoint
ALTER TABLE "bot_configs" ADD CONSTRAINT "bot_configs_botUserId_unique" UNIQUE("bot_user_id");--> statement-breakpoint
ALTER TABLE "loyalty_balances" ADD CONSTRAINT "loyalty_balances_points_nonneg" CHECK ("loyalty_balances"."points" >= 0);--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_tx_delta_nonzero" CHECK ("loyalty_transactions"."delta" <> 0);--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_tx_sign_ck" CHECK (("loyalty_transactions"."reason" in ('watch', 'prediction_payout', 'prediction_refund') and "loyalty_transactions"."delta" > 0)
       or ("loyalty_transactions"."reason" in ('command', 'prediction_bet', 'poll_vote') and "loyalty_transactions"."delta" < 0)
       or "loyalty_transactions"."reason" = 'moderator_adjust');--> statement-breakpoint
ALTER TABLE "raids" ADD CONSTRAINT "raids_cancel_ck" CHECK (("raids"."status" = 'canceled') = ("raids"."cancel_reason" is not null));