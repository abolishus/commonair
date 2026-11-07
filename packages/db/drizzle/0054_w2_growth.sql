CREATE TYPE "public"."signup_intent" AS ENUM('none', 'follow', 'chat', 'support', 'predict', 'clip', 'watch', 'stream', 'import', 'join');--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'membership';--> statement-breakpoint
CREATE TABLE "growth_daily" (
	"day" date NOT NULL,
	"metric" text NOT NULL,
	"value" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_daily_day_metric_pk" PRIMARY KEY("day","metric"),
	CONSTRAINT "growth_daily_value_nonneg" CHECK ("growth_daily"."value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ui_counters" (
	"day" date NOT NULL,
	"surface" text NOT NULL,
	"action" text NOT NULL,
	"step" text DEFAULT 'none' NOT NULL,
	"count" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ui_counters_day_surface_action_step_pk" PRIMARY KEY("day","surface","action","step"),
	CONSTRAINT "ui_counters_count_nonneg" CHECK ("ui_counters"."count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signup_intent" "signup_intent";