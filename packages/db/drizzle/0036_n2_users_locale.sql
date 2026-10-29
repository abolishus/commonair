ALTER TABLE "users" ALTER COLUMN "locale" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "locale" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_locale_format" CHECK ("users"."locale" ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$');--> statement-breakpoint
-- ADR 0029: null means "not chosen". No UI ever wrote this column and 'en' was only the default,
-- so every 'en' is a default, not a choice (no instance serves non-English users yet).
UPDATE "users" SET "locale" = NULL WHERE "locale" = 'en';
