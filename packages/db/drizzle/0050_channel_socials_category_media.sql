ALTER TABLE "channels" ADD COLUMN "socials" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "broadcasts_category_idx" ON "broadcasts" USING btree ("category_id");