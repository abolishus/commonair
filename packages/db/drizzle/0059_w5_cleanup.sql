CREATE TABLE "channel_schedule_one_offs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer NOT NULL,
	"title" text,
	"category_id" uuid,
	"cancels_slot_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_schedule_one_offs_duration" CHECK ("channel_schedule_one_offs"."duration_minutes" BETWEEN 15 AND 720),
	CONSTRAINT "channel_schedule_one_offs_title" CHECK ("channel_schedule_one_offs"."title" IS NULL OR char_length("channel_schedule_one_offs"."title") BETWEEN 1 AND 140)
);
--> statement-breakpoint
CREATE TABLE "channel_schedule_slots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"start_local" time NOT NULL,
	"duration_minutes" integer NOT NULL,
	"title" text,
	"category_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_schedule_slots_weekday" CHECK ("channel_schedule_slots"."weekday" BETWEEN 1 AND 7),
	CONSTRAINT "channel_schedule_slots_duration" CHECK ("channel_schedule_slots"."duration_minutes" BETWEEN 15 AND 720),
	CONSTRAINT "channel_schedule_slots_title" CHECK ("channel_schedule_slots"."title" IS NULL OR char_length("channel_schedule_slots"."title") BETWEEN 1 AND 140)
);
--> statement-breakpoint
CREATE TABLE "channel_schedules" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "renewal_stopped_by_deletion_id" uuid;--> statement-breakpoint
ALTER TABLE "membership_shares" ADD COLUMN "refund_details_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel_schedule_one_offs" ADD CONSTRAINT "channel_schedule_one_offs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_schedule_one_offs" ADD CONSTRAINT "channel_schedule_one_offs_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_schedule_one_offs" ADD CONSTRAINT "channel_schedule_one_offs_cancels_slot_id_channel_schedule_slots_id_fk" FOREIGN KEY ("cancels_slot_id") REFERENCES "public"."channel_schedule_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_schedule_slots" ADD CONSTRAINT "channel_schedule_slots_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_schedule_slots" ADD CONSTRAINT "channel_schedule_slots_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_schedules" ADD CONSTRAINT "channel_schedules_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_schedule_one_offs_channel_idx" ON "channel_schedule_one_offs" USING btree ("channel_id","starts_at");--> statement-breakpoint
CREATE INDEX "channel_schedule_slots_channel_idx" ON "channel_schedule_slots" USING btree ("channel_id");--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_renewal_stopped_by_deletion_id_account_deletions_id_fk" FOREIGN KEY ("renewal_stopped_by_deletion_id") REFERENCES "public"."account_deletions"("id") ON DELETE set null ON UPDATE no action;