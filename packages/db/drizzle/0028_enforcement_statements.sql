CREATE TYPE "public"."enforcement_automated_decision" AS ENUM('fully', 'partially', 'not');--> statement-breakpoint
CREATE TYPE "public"."enforcement_content_type" AS ENUM('broadcast', 'vod', 'clip', 'upload', 'channel', 'account');--> statement-breakpoint
CREATE TYPE "public"."enforcement_delivery_channel" AS ENUM('email', 'in_app');--> statement-breakpoint
CREATE TYPE "public"."enforcement_ground" AS ENUM('terms', 'illegal');--> statement-breakpoint
CREATE TYPE "public"."enforcement_restriction_detail" AS ENUM('removed', 'disabled', 'restricted', 'age_gated', 'suspended', 'none');--> statement-breakpoint
CREATE TYPE "public"."enforcement_restriction_kind" AS ENUM('visibility', 'service', 'account', 'warning');--> statement-breakpoint
CREATE TYPE "public"."enforcement_source" AS ENUM('own_initiative', 'notice_art16');--> statement-breakpoint
ALTER TYPE "public"."legal_document_kind" ADD VALUE 'enforcement_notice';--> statement-breakpoint
CREATE TABLE "enforcement_statement_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"statement_id" uuid NOT NULL,
	"channel" "enforcement_delivery_channel" NOT NULL,
	"sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enforcement_statements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_audit_id" uuid NOT NULL,
	"source_action" text NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"channel_id" uuid,
	"content_type" "enforcement_content_type" NOT NULL,
	"content_id" uuid NOT NULL,
	"restriction_kind" "enforcement_restriction_kind" NOT NULL,
	"restriction_detail" "enforcement_restriction_detail" NOT NULL,
	"restriction_ends_at" timestamp with time zone,
	"territorial_scope" text DEFAULT 'all' NOT NULL,
	"facts" jsonb NOT NULL,
	"source" "enforcement_source" NOT NULL,
	"automated_detection" boolean NOT NULL,
	"automated_decision" "enforcement_automated_decision" NOT NULL,
	"ground_kind" "enforcement_ground" NOT NULL,
	"clause_id" text NOT NULL,
	"clause_version" integer NOT NULL,
	"legal_basis" text,
	"guidelines_document_id" uuid NOT NULL,
	"notice_document_id" uuid NOT NULL,
	"appeal_subject_type" text,
	"appeal_subject_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "enforcement_statements_territorial_scope_ck" CHECK ("enforcement_statements"."territorial_scope" = 'all'),
	CONSTRAINT "enforcement_statements_clause_version_ck" CHECK ("enforcement_statements"."clause_version" >= 1),
	CONSTRAINT "enforcement_statements_legal_basis_ck" CHECK ("enforcement_statements"."legal_basis" is null or "enforcement_statements"."ground_kind" = 'illegal'),
	CONSTRAINT "enforcement_statements_appeal_ck" CHECK (("enforcement_statements"."appeal_subject_type" is null) = ("enforcement_statements"."appeal_subject_id" is null)),
	CONSTRAINT "enforcement_statements_facts_ck" CHECK (jsonb_typeof("enforcement_statements"."facts") = 'object' and "enforcement_statements"."facts" ->> 'code' is not null)
);
--> statement-breakpoint
ALTER TABLE "enforcement_statement_deliveries" ADD CONSTRAINT "enforcement_statement_deliveries_statement_id_enforcement_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."enforcement_statements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enforcement_statements" ADD CONSTRAINT "enforcement_statements_source_audit_id_audit_log_id_fk" FOREIGN KEY ("source_audit_id") REFERENCES "public"."audit_log"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enforcement_statements" ADD CONSTRAINT "enforcement_statements_guidelines_document_id_legal_documents_id_fk" FOREIGN KEY ("guidelines_document_id") REFERENCES "public"."legal_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enforcement_statements" ADD CONSTRAINT "enforcement_statements_notice_document_id_legal_documents_id_fk" FOREIGN KEY ("notice_document_id") REFERENCES "public"."legal_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "enforcement_statement_deliveries_uq" ON "enforcement_statement_deliveries" USING btree ("statement_id","channel");--> statement-breakpoint
CREATE INDEX "enforcement_statement_deliveries_unsent_idx" ON "enforcement_statement_deliveries" USING btree ("created_at") WHERE "enforcement_statement_deliveries"."sent_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "enforcement_statements_source_recipient_uq" ON "enforcement_statements" USING btree ("source_audit_id","recipient_user_id");--> statement-breakpoint
CREATE INDEX "enforcement_statements_recipient_idx" ON "enforcement_statements" USING btree ("recipient_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action","created_at");