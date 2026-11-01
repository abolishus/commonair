<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Batch 6 handoff prompt

Paste this into a new session started in the repository.

---

You are the orchestrator for CommonAir batch 6: W2, feature-wins wave 2. Repo: this checkout,
branch `main`, at the batch 6 planning commit or later. Batch 5 (the rest of N2) is done: CI green
on `63ccab01` with every job, including all seven harness shards and the new `e2e-basic-en-xa`.

**Read first:** AGENTS.md; `.claude/briefs/batch6/README.md` (gates, decisions (a)–(r) — final,
path ownership, waves, shared rules, milestone checks); `.claude/briefs/w2/contract-step.md`; the
nine unit briefs in `.claude/briefs/w2/`; `.claude/briefs/next/W2-feature-wave.md`;
`.claude/briefs/_done-means.md`; PROGRESS.md "In flight" (the batch 5 and batch 6 paragraphs).

**Do, in order:**

1. **Contract step** (`w2/contract-step.md`) on `main`: implement → independent review → fix,
   as one commit (or a short series), push, CI green. It is large (two migrations, contracts,
   config, four seams, `packages/chat-filter`, attestation crypto and vectors, stubs, namespaces,
   placeholder routes, harness and CI scaffolding, `w2-selectors.md`). Use the Workflow tool with a
   few agents on disjoint parts if that helps, then integrate and review it whole. Regenerate the
   self-host key lists (`bun scripts/selfhost/unit-env.ts`) for the new env vars, and add
   `SEED_ROUTES` rows for the new routes (another session owns the seed under
   `.claude/briefs/seed-full/`; coordinate through the routes file only).
2. **Wave 1** with the Workflow tool: W2-splits, W2-captions, W2-rollup-analytics,
   W2-enforcement-report, W2-dvr, W2-rehearsal; branches `w2/<unit>` (README "Shared rules").
3. **Merge wave 1** (no two branches on one file; `git merge --no-ff --signoff` with the
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer; apply or decline contract
   requests; lift `PENDING_W2_*` entries as units merge), push, CI green.
4. **Wave 2**: W2b-attestations, W2b-group-appeals, W2-vod-watch. Merge, push, CI green.
5. **Milestone** (README "Milestone checks"), PROGRESS, then plan batch 7 (W3 + N3 + N4).

**Workflow script:** reuse batch 5's
`~/.claude/projects/-Users-joshe-Repos-bcon/b9d97af9-926b-4e05-ad45-3d22dbfa9fcb/workflows/scripts/batch5-wave2-wf_ace18897-ebf.js`
(implement schema with worktree, branch, commits, report; per-unit reviewer focus via `extra`; a
fix agent that `cd`s into the worktree). Change the units, the base sha and the lessons line.
Reviewer focus per unit: splits — ledger invariants (sum to zero, per-recipient holds, chargeback
order, suspense debits only by the allowed kinds); captions — pinned image and weights, WER method,
cue timing on the media clock, no transcript kept when VODs are off; rollup — rehearsal filtered,
k-anonymity (groups < 5), settle timing; enforcement — k = 10 suppression, `rule_ref` written at
every platform action, no channel actions counted; DVR — mode-aware fetch judging, `dm` refusal,
rehearsal refusal, 404 timing after removal; rehearsal — nothing downstream sees a rehearsal;
attestations — the format against `vectors.json`, the chain trigger, key only on the worker;
group appeals — rate limits, re-score scope, supersede entry; vod-watch — visibility, blocks,
`retained` false.

**CI on `main` is the gate:**

- Never run `bun run verify`, `verify:full`, harness scenarios or image rebuilds locally, except a
  targeted check to debug a specific CI failure.
- Read a failed job with `gh api --allow-escape-sequences repos/abolishus/commonair/actions/jobs/<id>/logs`
  (strip escapes with `sed 's/\x1b\[[0-9;]*m//g'`). Harness artifacts upload on failure.
- Watch the **`ci` workflow** run, not CodeQL or scorecard (they finish first and are green on
  their own): `gh run list --branch main --workflow ci`.
- `gh run rerun <run> --failed` for infrastructure flakes once the run has completed. Do not push
  while a run with harness shards you need is still in progress: a new push can cancel it.
- Hand a product-looking failure to an agent with a precise brief (the failing check, its data, the
  code paths, "reproduce in a unit test first").

**Lessons from batch 5:**

- Run `vp fmt` on every file you touch at integration, including one-line call-site edits; the
  static job fails on format alone.
- `checkCatalog(namespaces, { keySegment })` lets a catalog widen later key segments (email uses
  it for clause ids with `-`); `checkTranslation` is in the browser-safe `@commonair/i18n`.
- Every unit that adds English keys writes `es` in the same change; `REQUIRED_LOCALES = ["es"]`
  fails CI otherwise. The `e2e-basic-en-xa` scan flags English left on pages it visits: keep new
  pages' text in catalogs, and treat instance or channel content (legal titles, a streamer's own
  names) as content, not literals.
- An English default stored in data (the contract's points name `"points"`) needs a display
  mapping to the catalog (`displayPointsName`).
- Flakes seen: `packages/moderation` ONNX test (timeout now 30 s); `services/media`
  "transcode ladder starts above the viewer threshold" (once). Batch 4's watch list still holds.

**Open for the user (don't block on them):** counsel on split recipients (decision (a): not a
blocker), captions and analytics privacy text; Hosted Weblate signup and GitHub app; visual
checks under `es` and `en-XA`; a fluent read of the Spanish; the LTR regression and Storybook
RTL passes from batch 5.
