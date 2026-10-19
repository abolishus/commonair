ALTER TABLE "payments" ADD COLUMN "tier" smallint;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "quantity" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "gift_payment_id" uuid;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_gift_payment_id_payments_id_fk" FOREIGN KEY ("gift_payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "payments_user_idx" ON "payments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "subscriptions_gift_payment_idx" ON "subscriptions" USING btree ("gift_payment_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_quantity_range" CHECK ("payments"."quantity" between 1 and 100);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tier_range" CHECK ("payments"."tier" is null or "payments"."tier" between 1 and 3);--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tier_range" CHECK ("subscriptions"."tier" between 1 and 3);