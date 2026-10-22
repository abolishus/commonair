ALTER TYPE "public"."share_status" ADD VALUE 'refund_pending' BEFORE 'refunded';--> statement-breakpoint
ALTER TYPE "public"."share_status" ADD VALUE 'cancelled';