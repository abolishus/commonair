CREATE TYPE "public"."patronage_payout_status" AS ENUM('pending', 'paid', 'failed', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."payout_transfer_status" AS ENUM('pending', 'created', 'failed', 'reversed');--> statement-breakpoint
CREATE TABLE "patronage_payouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"period_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_ref" text,
	"status" "patronage_payout_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "patronage_payouts_amount_positive" CHECK ("patronage_payouts"."amount_cents" > 0),
	CONSTRAINT "patronage_payouts_currency_format" CHECK ("patronage_payouts"."currency" ~ '^[a-z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "payout_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payout_id" uuid NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_ref" text,
	"destination_ref" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" "payout_transfer_status" DEFAULT 'pending' NOT NULL,
	"reversed_cents" bigint DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_transfers_amount_positive" CHECK ("payout_transfers"."amount_cents" > 0),
	CONSTRAINT "payout_transfers_currency_format" CHECK ("payout_transfers"."currency" ~ '^[a-z]{3}$'),
	CONSTRAINT "payout_transfers_reversed_bounds" CHECK ("payout_transfers"."reversed_cents" >= 0 and "payout_transfers"."reversed_cents" <= "payout_transfers"."amount_cents"),
	CONSTRAINT "payout_transfers_failure_code_len" CHECK ("payout_transfers"."failure_code" is null or length("payout_transfers"."failure_code") <= 64)
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "gift" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "patronage_payouts" ADD CONSTRAINT "patronage_payouts_period_id_patronage_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."patronage_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patronage_payouts" ADD CONSTRAINT "patronage_payouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_transfers" ADD CONSTRAINT "payout_transfers_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patronage_payouts_period_user_uq" ON "patronage_payouts" USING btree ("period_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patronage_payouts_idempotency_uq" ON "patronage_payouts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "patronage_payouts_user_idx" ON "patronage_payouts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_transfers_payout_uq" ON "payout_transfers" USING btree ("payout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_transfers_provider_ref_uq" ON "payout_transfers" USING btree ("provider","provider_ref") WHERE "payout_transfers"."provider_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_transfers_idempotency_uq" ON "payout_transfers" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "payout_transfers_status_idx" ON "payout_transfers" USING btree ("status","created_at");--> statement-breakpoint
-- Batch 8 decision (d): mark existing gift payments (a payment some subscription names in
-- gift_payment_id). Where one gifter already holds several pending gifts for a channel, only the
-- newest is marked while pending, so 0049's one-pending-gift index can be built; the older ones
-- expire as before (money-expire-pending) and gain the flag nowhere else.
UPDATE "payments" p
   SET "gift" = true
 WHERE EXISTS (SELECT 1 FROM "subscriptions" s WHERE s."gift_payment_id" = p."id")
   AND (p."status" <> 'pending'
        OR NOT EXISTS (SELECT 1 FROM "payments" q
                        WHERE q."status" = 'pending' AND q."id" <> p."id"
                          AND q."user_id" = p."user_id" AND q."channel_id" = p."channel_id"
                          AND EXISTS (SELECT 1 FROM "subscriptions" s2 WHERE s2."gift_payment_id" = q."id")
                          AND (q."created_at", q."id") > (p."created_at", p."id")));
