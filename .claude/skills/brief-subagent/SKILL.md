---
name: brief-subagent
description: Write a self-contained brief for a subagent implementing a CommonAir work unit, using the AGENTS.md template with explicit file ownership, contracts, tests and done criteria.
---

<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

1. Pick the unit from PLAN.md. List exactly the paths it owns; confirm no other in-flight unit (see PROGRESS.md "In flight") owns any of them.
2. Commit shared contracts first (contracts, db schema, env vars) so the subagent builds against committed code.
3. Fill the "Subagent briefing template" in AGENTS.md: owned paths, contracts (file paths and names), behaviors with edge cases, required tests, done criteria, and the rule to report contract requests instead of editing files it does not own.
4. Record the unit, agent, and owned paths under "In flight" in PROGRESS.md.
5. On completion: read its report, check `git status` touches only its paths, run `bun run verify`, have a reviewer subagent (that did not write the code) review the diff against AGENTS.md, fix findings, re-verify, commit.
