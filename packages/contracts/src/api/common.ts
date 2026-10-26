// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { oc } from "@orpc/contract";
import { z } from "zod";
import type { Scope } from "../scopes.ts";

/**
 * Who may call a procedure.
 * - public: anyone, signed in or not
 * - user: a signed-in member (session cookie) or an OAuth token with `scopes`
 * - owner: the channel owner (or an editor) of the channel named in the input
 * - moderator: owner, editor, or moderator of the channel in the input
 * - admin / treasurer / platform-moderator: platform roles
 * - legal: the `legal` platform role only (T0 cases, evidence, NCMEC drafts, holds)
 * - safety-staff: platform moderators, admins and `legal` (mod queue, NCII requests)
 * - finance: treasurers and admins (patronage approval and periods; ADR 0020)
 * - relay: a registered relay node's token
 * - overlay: an overlay token for one channel
 */
export type Access =
  | "public"
  | "user"
  | "owner"
  | "moderator"
  | "admin"
  | "treasurer"
  | "platform-moderator"
  | "legal"
  | "safety-staff"
  | "finance"
  | "relay"
  | "overlay";

export interface ProcedureMeta {
  access: Access;
  /**
   * OAuth token callers: `undefined` = session only (tokens are refused); `[]` = any valid
   * token; otherwise the token must hold every listed scope. Session callers act with full
   * rights for themselves. Public procedures ignore this.
   */
  scopes?: Scope[];
  /** Per-caller rate limit bucket name (see services/api rate limits). */
  rateLimit?: "default" | "write" | "auth" | "chat" | "expensive" | "playback";
}

export const base = oc.$meta<ProcedureMeta>({ access: "public" }).errors({
  UNAUTHORIZED: { message: "Sign in required" },
  FORBIDDEN: { message: "You do not have permission to do this" },
  NOT_FOUND: { message: "Not found" },
  CONFLICT: { message: "Conflicts with the current state" },
  RATE_LIMITED: { message: "Too many requests", data: z.object({ retryAfterSeconds: z.number() }) },
  PRECONDITION_FAILED: {
    message: "A requirement for this action is not met",
    data: z.object({ requirement: z.string() }),
  },
});

export const Id = z.uuid();
export const Slug = z
  .string()
  .min(3)
  .max(25)
  .regex(/^[a-z0-9_]+$/, "lowercase letters, digits and underscores");
export const Timestamp = z.iso.datetime({ offset: true });
export const Money = z.object({ cents: z.number().int(), currency: z.string().length(3) });
export type Money = z.infer<typeof Money>;

export const PageInput = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const ChannelRef = z.object({ channel: Slug });
/** Same-origin return path after checkout (relative only; never an absolute URL, to prevent open redirects). */
export const ReturnPath = z
  .string()
  .max(500)
  .regex(/^\/(?!\/)[^\s\\]*$/, "must be a relative path starting with a single /");
/** A JSON value bounded in serialized size. */
export const BoundedJson = (maxBytes: number) =>
  z
    .unknown()
    .refine((v) => JSON.stringify(v ?? null).length <= maxBytes, `must serialize to at most ${maxBytes} bytes`);
export const ShortText = z.string().max(64);
export const Ok = z.object({ ok: z.literal(true) });

/**
 * Upload rejections (`channels.commitUpload`). The same response for every reason, so a caller
 * cannot learn whether content matched a hash list.
 */
export const UPLOAD_REJECTED = {
  UNPROCESSABLE_CONTENT: {
    status: 422,
    message: "This file cannot be used",
    data: z.object({ reason: z.literal("upload_rejected") }),
  },
} as const;
/** `coop.proposals.vote`: the caller is not in the frozen electorate, or the window is closed. */
export const VOTE_REFUSED = {
  FORBIDDEN: {
    message: "You do not have permission to do this",
    data: z.object({ reason: z.literal("not_in_electorate") }).optional(),
  },
  CONFLICT: {
    message: "Conflicts with the current state",
    data: z.object({ reason: z.literal("voting_closed") }).optional(),
  },
} as const;
/** `coop.patronage.approve` by the person who ran the computation (ADR 0020). */
export const SECOND_APPROVER = {
  FORBIDDEN: {
    message: "You do not have permission to do this",
    data: z.object({ reason: z.literal("second_approver") }).optional(),
  },
} as const;
/** Playback of a mature broadcast without a signed-in, 18+-confirmed viewer. */
export const MATURE_GATE = {
  FORBIDDEN: {
    message: "You do not have permission to do this",
    data: z.object({ reason: z.literal("mature_gate") }).optional(),
  },
} as const;
