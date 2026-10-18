ALTER TABLE "election_candidates" ADD COLUMN "nominated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "patronage_periods" ADD COLUMN "retained_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "patronage_periods" ADD COLUMN "retained_lines" jsonb DEFAULT '[]'::jsonb NOT NULL;