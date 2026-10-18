ALTER TABLE "two_factors" ADD COLUMN "verified" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factors" ADD COLUMN "failed_verification_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factors" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mature_confirmed_at" timestamp with time zone;