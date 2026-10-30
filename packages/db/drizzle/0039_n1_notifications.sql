CREATE TYPE "public"."discord_webhook_error" AS ENUM('unauthorized', 'not_found', 'rate_limited', 'rejected', 'network');--> statement-breakpoint
CREATE TYPE "public"."notification_medium" AS ENUM('in_app', 'email', 'push');--> statement-breakpoint
CREATE TABLE "discord_webhooks" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"set_by" uuid,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_posted_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" "discord_webhook_error",
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_email_queue" (
	"user_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_email_queue_user_id_event_id_pk" PRIMARY KEY("user_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "notification_go_live_sends" (
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"last_sent_at" timestamp with time zone NOT NULL,
	"event_id" uuid NOT NULL,
	CONSTRAINT "notification_go_live_sends_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"channel_id" uuid,
	"medium" "notification_medium" NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_prefs_uq" UNIQUE NULLS NOT DISTINCT("user_id","type","medium","channel_id")
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint_hash" text NOT NULL,
	"subscription" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "push_subscriptions_endpointHash_unique" UNIQUE("endpoint_hash")
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "discord_webhooks" ADD CONSTRAINT "discord_webhooks_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_webhooks" ADD CONSTRAINT "discord_webhooks_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_email_queue" ADD CONSTRAINT "notification_email_queue_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_email_queue" ADD CONSTRAINT "notification_email_queue_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_email_queue" ADD CONSTRAINT "notification_email_queue_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_go_live_sends" ADD CONSTRAINT "notification_go_live_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_go_live_sends" ADD CONSTRAINT "notification_go_live_sends_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_email_queue_due_idx" ON "notification_email_queue" USING btree ("queued_at");--> statement-breakpoint
CREATE INDEX "notification_prefs_channel_idx" ON "notification_preferences" USING btree ("channel_id") WHERE "notification_preferences"."channel_id" is not null;--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "follows_channel_notify_idx" ON "follows" USING btree ("channel_id","follower_id") WHERE "follows"."notify";--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_uq" ON "notifications" USING btree ("user_id","dedupe_key") WHERE "notifications"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("user_id") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notifications_go_live_channel_idx" ON "notifications" USING btree (("payload"->>'channelId')) WHERE "notifications"."type" = 'go_live';