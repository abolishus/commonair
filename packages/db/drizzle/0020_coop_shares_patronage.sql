ALTER TABLE "council_terms" ADD COLUMN "txid" bigint DEFAULT txid_current() NOT NULL;--> statement-breakpoint
ALTER TABLE "patronage_periods" ADD COLUMN "computed_by_id" uuid;--> statement-breakpoint
ALTER TABLE "membership_shares" ADD CONSTRAINT "membership_shares_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patronage_periods" ADD CONSTRAINT "patronage_periods_computed_by_id_users_id_fk" FOREIGN KEY ("computed_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patronage_periods" ADD CONSTRAINT "patronage_periods_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "membership_shares_status_idx" ON "membership_shares" USING btree ("status","created_at");