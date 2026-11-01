CREATE INDEX "enforcement_statements_created_idx" ON "enforcement_statements" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "enforcement_statements_appeal_subject_idx" ON "enforcement_statements" USING btree ("appeal_subject_type","appeal_subject_id");--> statement-breakpoint
CREATE INDEX "mod_actions_platform_rule_idx" ON "mod_actions" USING btree ("created_at") WHERE "mod_actions"."scope" = 'platform' and "mod_actions"."rule_ref" is not null;--> statement-breakpoint
CREATE INDEX "ncii_requests_deadline_idx" ON "ncii_requests" USING btree ("deadline_at");