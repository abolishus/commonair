ALTER TYPE "public"."notification_type" ADD VALUE 'vod_ready';--> statement-breakpoint
CREATE TABLE "channel_setup_steps" (
	"channel_id" uuid NOT NULL,
	"step" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_setup_steps_channel_id_step_pk" PRIMARY KEY("channel_id","step"),
	CONSTRAINT "channel_setup_steps_step" CHECK ("channel_setup_steps"."step" IN ('bring_your_audience'))
);
--> statement-breakpoint
ALTER TABLE "vods" ADD COLUMN "views" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_setup_steps" ADD CONSTRAINT "channel_setup_steps_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;