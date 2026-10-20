CREATE TYPE "public"."content_label" AS ENUM('mature');--> statement-breakpoint
CREATE TYPE "public"."evidence_kind" AS ENUM('frame', 'upload', 'vod_object', 'clip_object', 'thumbnail');--> statement-breakpoint
CREATE TYPE "public"."evidence_storage" AS ENUM('inline', 'bucket');--> statement-breakpoint
CREATE TYPE "public"."hash_list_category" AS ENUM('csam', 'ncii');--> statement-breakpoint
CREATE TYPE "public"."legal_hold_reason" AS ENUM('csam_match', 'ncii_match', 'csam_confirmed', 'law_enforcement', 'litigation');--> statement-breakpoint
CREATE TYPE "public"."moderation_case_origin" AS ENUM('hash_list', 'classifier', 'human');--> statement-breakpoint
CREATE TYPE "public"."moderation_case_status" AS ENUM('open', 'labelled', 'cleared', 'actioned', 'dismissal_pending', 'dismissed', 'confirmed');--> statement-breakpoint
CREATE TYPE "public"."moderation_category" AS ENUM('sexual', 'graphic_violence', 'weapons', 'self_harm');--> statement-breakpoint
CREATE TYPE "public"."moderation_subject" AS ENUM('broadcast', 'vod', 'clip', 'upload');--> statement-breakpoint
CREATE TYPE "public"."moderation_tier" AS ENUM('t0', 't1', 't2');--> statement-breakpoint
CREATE TYPE "public"."ncii_relationship" AS ENUM('self', 'representative');--> statement-breakpoint
CREATE TYPE "public"."ncii_status" AS ENUM('received', 'removed', 'rejected', 'auto_hidden');--> statement-breakpoint
CREATE TYPE "public"."ncmec_report_status" AS ENUM('draft', 'filed', 'withdrawn');--> statement-breakpoint
ALTER TYPE "public"."mod_action" ADD VALUE 'end_stream';--> statement-breakpoint
ALTER TYPE "public"."mod_action" ADD VALUE 'warn';--> statement-breakpoint
ALTER TYPE "public"."platform_role" ADD VALUE 'legal';--> statement-breakpoint
ALTER TYPE "public"."report_reason" ADD VALUE 'ncii' BEFORE 'other';--> statement-breakpoint
CREATE TABLE "content_labels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"label" "content_label" NOT NULL,
	"case_id" uuid NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by_id" uuid,
	"removed_reason" text
);
--> statement-breakpoint
CREATE TABLE "evidence_audit_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"checked" integer DEFAULT 0 NOT NULL,
	"missing" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"mismatched" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"incident_id" uuid
);
--> statement-breakpoint
CREATE TABLE "evidence_objects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hold_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"kind" "evidence_kind" NOT NULL,
	"storage" "evidence_storage" NOT NULL,
	"sealed" "bytea",
	"storage_key" text,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_type" text NOT NULL,
	"key_id" text NOT NULL,
	"pdq" text,
	"pdq_quality" integer,
	"source_subject_type" "moderation_subject" NOT NULL,
	"source_subject_id" uuid NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_objects_storage" CHECK (("evidence_objects"."storage" = 'inline' and "evidence_objects"."sealed" is not null and "evidence_objects"."storage_key" is null and octet_length("evidence_objects"."sealed") <= 1049600) or ("evidence_objects"."storage" = 'bucket' and "evidence_objects"."storage_key" is not null and "evidence_objects"."sealed" is null)),
	CONSTRAINT "evidence_objects_sha256" CHECK ("evidence_objects"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "local_hash_list" (
	"id" uuid PRIMARY KEY NOT NULL,
	"category" "hash_list_category" NOT NULL,
	"pdq" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"added_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_id" uuid,
	CONSTRAINT "local_hash_list_pdq" CHECK ("local_hash_list"."pdq" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "moderation_cases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tier" "moderation_tier" NOT NULL,
	"status" "moderation_case_status" DEFAULT 'open' NOT NULL,
	"origin" "moderation_case_origin" NOT NULL,
	"subject_type" "moderation_subject" NOT NULL,
	"subject_id" uuid NOT NULL,
	"channel_id" uuid,
	"user_id" uuid,
	"category" "moderation_category",
	"list_category" "hash_list_category",
	"priority" integer DEFAULT 0 NOT NULL,
	"sla_due_at" timestamp with time zone,
	"first_reviewer_id" uuid,
	"first_reviewed_at" timestamp with time zone,
	"first_review_note" text,
	"resolved_by_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tier" "moderation_tier" NOT NULL,
	"origin" "moderation_case_origin" NOT NULL,
	"case_id" uuid NOT NULL,
	"subject_type" "moderation_subject" NOT NULL,
	"subject_id" uuid NOT NULL,
	"channel_id" uuid,
	"user_id" uuid,
	"category" "moderation_category",
	"score" double precision,
	"list_category" "hash_list_category",
	"distance" integer,
	"quality" integer,
	"provider" text NOT NULL,
	"provider_version" text NOT NULL,
	"evidence_id" uuid,
	"frame_key" text,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_flags_signal" CHECK (("moderation_flags"."origin" = 'human') or ("moderation_flags"."origin" = 'hash_list' and "moderation_flags"."tier" = 't0' and "moderation_flags"."list_category" is not null and "moderation_flags"."distance" is not null) or ("moderation_flags"."origin" = 'classifier' and "moderation_flags"."tier" in ('t1', 't2') and "moderation_flags"."category" is not null and "moderation_flags"."score" is not null))
);
--> statement-breakpoint
CREATE TABLE "ncii_request_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"url" text NOT NULL,
	"subject_type" "moderation_subject",
	"subject_id" uuid,
	"upload_key" text,
	"hidden_at" timestamp with time zone,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ncii_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" "ncii_status" DEFAULT 'received' NOT NULL,
	"requester_name" text NOT NULL,
	"requester_email" text NOT NULL,
	"relationship" "ncii_relationship" NOT NULL,
	"content_urls" text[] NOT NULL,
	"description" text NOT NULL,
	"good_faith" boolean NOT NULL,
	"signature" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"escalated24_at" timestamp with time zone,
	"escalated36_at" timestamp with time zone,
	"auto_hidden_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by_id" uuid,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ncii_requests_good_faith" CHECK ("ncii_requests"."good_faith")
);
--> statement-breakpoint
CREATE TABLE "ncmec_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"hold_id" uuid NOT NULL,
	"user_id" uuid,
	"channel_id" uuid,
	"status" "ncmec_report_status" DEFAULT 'draft' NOT NULL,
	"incident_at" timestamp with time zone NOT NULL,
	"list_category" "hash_list_category",
	"snapshot_sealed" "bytea" NOT NULL,
	"key_id" text NOT NULL,
	"evidence_ids" uuid[] NOT NULL,
	"target" text DEFAULT 'ncmec' NOT NULL,
	"external_report_id" text,
	"filed_at" timestamp with time zone,
	"filed_by_id" uuid,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by_id" uuid,
	"withdrawn_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN "restricted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN "restricted_case_id" uuid;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD COLUMN "reason_code" "legal_hold_reason" DEFAULT 'law_enforcement' NOT NULL;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD COLUMN "case_id" uuid;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD COLUMN "filed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD COLUMN "eligible_for_release_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD COLUMN "release_reason" text;--> statement-breakpoint
ALTER TABLE "content_labels" ADD CONSTRAINT "content_labels_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_objects" ADD CONSTRAINT "evidence_objects_hold_id_legal_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."legal_holds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ncii_request_items" ADD CONSTRAINT "ncii_request_items_request_id_ncii_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."ncii_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ncmec_reports" ADD CONSTRAINT "ncmec_reports_hold_id_legal_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."legal_holds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_labels_active_uq" ON "content_labels" USING btree ("channel_id","label") WHERE "content_labels"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "evidence_objects_case_idx" ON "evidence_objects" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "evidence_objects_hold_idx" ON "evidence_objects" USING btree ("hold_id");--> statement-breakpoint
CREATE UNIQUE INDEX "local_hash_list_active_uq" ON "local_hash_list" USING btree ("category","pdq") WHERE "local_hash_list"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "moderation_cases_queue_idx" ON "moderation_cases" USING btree ("tier","status","priority","created_at");--> statement-breakpoint
CREATE INDEX "moderation_cases_user_idx" ON "moderation_cases" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "moderation_cases_subject_idx" ON "moderation_cases" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_cases_open_uq" ON "moderation_cases" USING btree ("subject_type","subject_id","tier") WHERE "moderation_cases"."status" in ('open', 'labelled', 'dismissal_pending');--> statement-breakpoint
CREATE INDEX "moderation_flags_case_idx" ON "moderation_flags" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "moderation_flags_subject_idx" ON "moderation_flags" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "ncii_request_items_request_idx" ON "ncii_request_items" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "ncii_request_items_subject_idx" ON "ncii_request_items" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "ncii_requests_open_idx" ON "ncii_requests" USING btree ("deadline_at") WHERE "ncii_requests"."decided_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ncmec_reports_case_uq" ON "ncmec_reports" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "ncmec_reports_status_idx" ON "ncmec_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "legal_holds_user_idx" ON "legal_holds" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "legal_holds_case_idx" ON "legal_holds" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "legal_holds_active_idx" ON "legal_holds" USING btree ("created_at") WHERE "legal_holds"."released_at" is null;