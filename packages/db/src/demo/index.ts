// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Demo data: seed and clear rows that carry the fixture anchors (see data.ts and anchors.ts). */
export { anchoredUser, demoIdentity } from "./anchors.ts";
export { CLEAR_STEPS, type ClearReport, clearDemo, clearDemoRows } from "./clear.ts";
export * from "./data.ts";
export { generatePassword, hashPassword, passwordProblem, verifyPassword } from "./password.ts";
export { type SeedResult, type SeedSummary, countAnchoredUsers, seedDemo, seedDemoRows } from "./seed.ts";
