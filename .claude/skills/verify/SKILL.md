---
name: verify
description: Run CommonAir's verification gate (format, lint, typecheck, unit, integration, license allowlist, stray-domain check, reuse, relay) and fix failures. Use before every commit and after integrating any change.
---

<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

1. Make sure infra is reachable: `bun scripts/infra.ts test` (Podman machine must be running on macOS: `podman machine start`).
2. Run `bun run verify`. For a single slice while iterating: `bun run verify --quick`, or the package's own `bun run test` / `bun run test:int`.
3. Fix the first failing step, rerun. Common fixes:
   - format: `vp fmt`
   - lint: fix the code; never disable a rule inline without a comment explaining why
   - licenses: check the dependency's license at its repo; if OSI-approved but missing from the allowlist, update `scripts/licenses.ts` and ADR 0002
   - stray domains: import `SITE` from `@commonair/config/site`
   - reuse: add the SPDX header (see any existing file of the same type)
4. At the end of a phase, `bun run verify:full` (includes the full harness scenario).
5. Nothing is committed red.
