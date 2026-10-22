-- E6 (docs/testing/e6-selectors.md, ADR 0021). Overlay tokens were never issued before E6 (the
-- route was 501), but revoke all but the newest unrevoked token per channel so the index builds.
UPDATE "overlay_tokens" o SET "revoked_at" = now()
WHERE o."revoked_at" IS NULL AND EXISTS (
  SELECT 1 FROM "overlay_tokens" n
  WHERE n."channel_id" = o."channel_id" AND n."revoked_at" IS NULL AND n."created_at" > o."created_at"
);--> statement-breakpoint
ALTER TABLE "overlay_tokens" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "vods_broadcast_idx" ON "vods" USING btree ("broadcast_id");--> statement-breakpoint
CREATE INDEX "data_exports_expiry_idx" ON "data_exports" USING btree ("expires_at") WHERE "data_exports"."status" = 'ready';--> statement-breakpoint
CREATE UNIQUE INDEX "overlay_tokens_active_uq" ON "overlay_tokens" USING btree ("channel_id") WHERE "overlay_tokens"."revoked_at" is null;