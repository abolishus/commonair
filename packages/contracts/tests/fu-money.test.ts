// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Follow-ups (unit money) enums: `REFUND_RECHECK_RESULTS` and `TRANSFER_SETTLE_OUTCOMES`, as the
 * treasurer procedures that carry them accept and refuse them.
 */
import type { z } from "zod";
import { describe, expect, test } from "vite-plus/test";
import { contract } from "../src/api/router.ts";
import { REFUND_RECHECK_RESULTS, REFUND_REQUEST_RESOLUTIONS, TRANSFER_SETTLE_OUTCOMES } from "../src/enums.ts";

const outputOf = (p: { "~orpc": { outputSchema?: unknown } }) => p["~orpc"].outputSchema as z.ZodType;
const inputOf = (p: { "~orpc": { inputSchema?: unknown } }) => p["~orpc"].inputSchema as z.ZodType;
const id = "01890000-0000-7000-8000-000000000001";

describe("follow-ups money enums", () => {
  test("recheck results: Stripe has it, definitely not, can't tell, or couldn't ask", () => {
    expect([...REFUND_RECHECK_RESULTS]).toEqual(["refunded", "pending", "failed", "none", "ambiguous", "unavailable"]);
    // Disjoint from what a treasurer records by hand except the shared "refunded" / "failed".
    expect(REFUND_RECHECK_RESULTS.filter((r) => (REFUND_REQUEST_RESOLUTIONS as readonly string[]).includes(r))).toEqual(
      ["refunded", "failed"],
    );
  });

  test("recheck's output takes each result and nothing else", () => {
    const result = (outputOf(contract.money.treasurer.refundRequests.recheck) as z.ZodObject<z.ZodRawShape>).shape
      .result as z.ZodType;
    for (const r of REFUND_RECHECK_RESULTS) expect(result.safeParse(r).success, r).toBe(true);
    for (const r of ["REFUNDED", "succeeded", "", null]) expect(result.safeParse(r).success, String(r)).toBe(false);
  });

  test("settleTransfer takes sent or not_sent, with an optional tr_ reference and a bounded note", () => {
    expect([...TRANSFER_SETTLE_OUTCOMES]).toEqual(["sent", "not_sent"]);
    const input = inputOf(contract.money.treasurer.settleTransfer);
    for (const outcome of TRANSFER_SETTLE_OUTCOMES)
      expect(input.safeParse({ transferId: id, outcome }).success, outcome).toBe(true);
    expect(input.safeParse({ transferId: id, outcome: "sent", reference: "tr_123" }).success).toBe(true);
    for (const outcome of ["failed", "Sent", "notsent"])
      expect(input.safeParse({ transferId: id, outcome }).success, outcome).toBe(false);
    expect(input.safeParse({ transferId: id, outcome: "sent", reference: "x".repeat(65) }).success).toBe(false);
    expect(input.safeParse({ transferId: id, outcome: "sent", note: "x".repeat(501) }).success).toBe(false);
    expect(input.parse({ transferId: id, outcome: "not_sent" })).toMatchObject({ note: "" });
    expect(input.safeParse({ transferId: "not-an-id", outcome: "sent" }).success).toBe(false);
  });
});
