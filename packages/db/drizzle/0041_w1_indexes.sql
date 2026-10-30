DROP INDEX "chat_messages_broadcast_media_idx";--> statement-breakpoint
CREATE INDEX "chat_messages_broadcast_at_idx" ON "chat_messages" USING btree ("broadcast_id",coalesce("media_ts", "created_at"),"id");--> statement-breakpoint
CREATE INDEX "ledger_transactions_ref_created_idx" ON "ledger_transactions" USING btree ("ref_type","created_at");