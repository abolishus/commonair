// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Error helpers and the boundary mapping: Zod validation → BAD_REQUEST with issues,
 * unique violations → CONFLICT, anything else → INTERNAL_SERVER_ERROR with no detail
 * (SQL and stack traces never reach clients).
 */
import { ORPCError, ValidationError } from "@orpc/server";

const STATUS = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  BAD_REQUEST: 400,
  RATE_LIMITED: 429,
} as const;
type Code = keyof typeof STATUS;

/** Errors declared in the contract's base error map are `defined`, so typed clients can match them. */
export const apiError = (code: Code, message?: string, data?: unknown) =>
  new ORPCError(code, { status: STATUS[code], message, data, defined: code !== "BAD_REQUEST" });

export const notFound = (what = "Not found") => apiError("NOT_FOUND", what);
export const forbidden = (why = "You do not have permission to do this") => apiError("FORBIDDEN", why);
export const conflict = (why = "Conflicts with the current state") => apiError("CONFLICT", why);
export const badRequest = (why: string) => apiError("BAD_REQUEST", why);
export const precondition = (requirement: string, message?: string) =>
  apiError("PRECONDITION_FAILED", message ?? "A requirement for this action is not met", { requirement });
export const rateLimited = (retryAfterSeconds: number) =>
  apiError("RATE_LIMITED", "Too many requests", { retryAfterSeconds });

/** Stub for procedures later units implement in their own route files. */
export function notImplemented(): never {
  throw new ORPCError("NOT_IMPLEMENTED", { status: 501, message: "This endpoint is not implemented yet" });
}

/** Postgres SQLSTATE of an error or anything in its cause chain (drizzle wraps driver errors). */
export function pgCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let depth = 0; e && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

export const isUniqueViolation = (err: unknown) => pgCode(err) === "23505";

/** Map an error leaving a handler to what the client may see. */
export function toClientError(err: unknown): ORPCError<string, unknown> {
  if (err instanceof ORPCError) {
    if (err.code === "BAD_REQUEST" && err.cause instanceof ValidationError)
      return new ORPCError("BAD_REQUEST", {
        status: 400,
        message: "Input validation failed",
        data: {
          issues: err.cause.issues.map((i) => ({
            path: (i.path ?? []).map((p) => (typeof p === "object" ? String(p.key) : String(p))),
            message: i.message,
          })),
        },
        cause: err.cause,
      });
    // Output validation failure is our bug; do not echo our own data shape back.
    if (err.code === "INTERNAL_SERVER_ERROR" && err.cause instanceof ValidationError)
      return new ORPCError("INTERNAL_SERVER_ERROR", { cause: err.cause });
    if (err.code === "INTERNAL_SERVER_ERROR" && isUniqueViolation(err.cause))
      return apiError("CONFLICT", "Already exists");
    return err;
  }
  if (isUniqueViolation(err)) return apiError("CONFLICT", "Already exists");
  return new ORPCError("INTERNAL_SERVER_ERROR", { cause: err });
}
