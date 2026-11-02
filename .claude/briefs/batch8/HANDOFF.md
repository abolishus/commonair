<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Batch 8 handoff prompt

Paste this into a new session started in the repository.

---

You are the orchestrator for CommonAir batch 8. It covers:

- R0's release prep toward `v0.1.0`;
- S1 stage 1 (S1-d, S1-b, S1-h);
- M1 on stripe-mock;
- L1's engineering (observability and the status page);
- the batch 6 and batch 7 follow-ups.

Repo: this checkout, branch `main`, at the batch 8 planning commit or later. Batch 7 (W3, N3, N4)
is merged at `43ae60dc`, with CI green on the push run. Check that its full `workflow_dispatch`
run went green too, and write the batch 7 milestone into PROGRESS if no one has.

**This batch is not ready to run yet.** The README's decision rows U1–U6 are **OPEN**, and the user
must answer them **before the contract step**. The unit briefs and the contract-step file are
written only after those answers. Your first job is to put U1–U6 to the user verbatim, with the
proposed answer for each, and wait.

**Read first:**

- AGENTS.md.
- `.claude/briefs/batch8/README.md`. It has:
  - what is done and left on `main`;
  - the twelve units with their gates and evidence;
  - decisions U1–U6 (OPEN) and (a)–(r) (orchestrator defaults);
  - the contract step's parts (A)–(D), the waves and the path ownership;
  - the shared rules and the milestone checks;
  - the follow-ups table, the briefs to write, and the post-launch review.
- `.claude/briefs/next/{R0-release,S1-scaling,M1-money-follow-ups,L1-public-instance}.md`.
- ADR 0007, ADR 0014, ADR 0020, ADR 0025, ADR 0032.
- `.claude/briefs/batch7/README.md` and `HANDOFF.md`, for the format and the lessons.
- `.claude/briefs/_done-means.md`.
- PROGRESS.md "In flight": the batch 7 and batch 6 paragraphs, and "Batch 1 (R0 + S1)".

**There is no counsel** (batch 7 decision (h)). Never block on a "counsel" gate. Take the
conservative default, and add the call to the README's "Post-launch review". M1 never takes a
live key (decision (b)).

**Do, in order:**

1. **Ask the user U1–U6.** Record the answers in the README's decision table: replace "OPEN" with
   the answer and the date. Adjust the units and waves if U1 drops M1 or U2 changes the release
   path. Commit (`docs(briefs): batch 8 decisions`).
2. **Write the briefs** listed in the README's "Briefs to write", with the `brief-subagent` skill
   and the AGENTS.md template:
   - `b8/contract-step.md` first;
   - then the twelve unit briefs (fewer if U1 drops M1).
   - Check every gate again against `main` with file:line evidence, as the README does. Then add
     this file's per-unit reviewer focus (below, to fill in) and commit.
3. **Contract step** (`b8/contract-step.md`) on `main`: implement, then an independent review,
   then fix.
   - Run it as a Workflow with up to four agents on parts (A)–(D), which touch disjoint files.
   - Part (B) ends with a database security review of `0049_b8_protections.sql`, done as
     `0002_protections_hardening.sql` was: every proven bypass gets a regression test.
   - If (A) finds that a trigger needs a superuser, stop and re-plan S1-b with the user
     (decision (a)).
   - Regenerate the self-host key lists (`bun scripts/selfhost/unit-env.ts`).
   - Push, and wait for CI green.
4. **Wave 1** with the Workflow tool: S1-b external, L1-observability, M1-gifts-refunds,
   M1-connect, B8-server and B8-web, on branches `s1/b-external`, `l1/observability`,
   `m1/gifts-refunds`, `m1/connect`, `b8/server` and `b8/web`.
5. **Merge wave 1:**
   - **Merge by commit sha, not branch name, and check that each merge landed** (`git log
     --oneline -1 <sha>` is an ancestor of `HEAD`).
   - No two branches may touch one file. Use `git merge --no-ff --signoff <sha>` with the
     `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer.
   - Apply or decline the contract requests. That includes the CI job for the external-services
     e2e, the image-license rows for new exporters, and any `compose.yaml` services.
   - Lift `PENDING_B8_*` entries as units merge.
   - Push, and wait for CI green.
6. **Wave 2:** S1-h backups-ext, M1-coop-money, R0-release-prep, L1-status, B8-player and
   B8-harness, on branches `s1/h-backups-ext`, `m1/coop-money`, `r0/release-prep`, `l1/status`,
   `b8/player` and `b8/harness`.
   - When S1-h merges, wire its `e2e-dump.ts` into `scripts/selfhost/e2e.ts`.
   - When B8-harness merges, update `harness/src/shards.ts` and the registry for the `e2e-relay`
     split.
   - Merge, push, CI green.
7. **Milestone** (README "Milestone checks"):
   - re-measure every shard;
   - write the privacy and terms drafts, and bump `PRIVACY_SEED_VERSION` and `TERMS_SEED_VERSION`;
   - get CI green on a push run and a full `workflow_dispatch` run;
   - write PROGRESS.
   - Then, per U2, hand the release to the user: rc.3 from a green `ci-ok`, R0 §3 on real droplets
     (U5), and `v0.1.0`.
   - Then plan batch 9: the ADR 0014 amendment's statement `v: 2` if accepted, S1-f if stage 1
     is live, N2's Arabic, and the carried items.

**Workflow scripts.** Reuse batch 7's or batch 6's. The batch 6 ones are in
`~/.claude/projects/-Users-joshe-Repos-bcon/a7fef824-1175-4b97-a672-f59dfeb5b8e5/workflows/scripts/`:

- the contract-step parts;
- the four-dimension review (change the dimensions to schema and ledger rules, money seams and
  stripe-mock, self-host and infra, web/harness/CI);
- the wave pipelines (implement, review, fix in the same worktree);
- the CI-fix fan-out.

Change the units, the base sha and the lessons line.

**Reviewer focus per unit:** to write with the briefs (step 2). Start from these:

- **S1-b:**
  - TLS really verified (`verify-full`, `rediss://`);
  - no bundled unit installed for an external service;
  - `upgrade` keeps the choice and runs `migrate` once;
  - no secret in a unit file or a log.
- **S1-h:**
  - the dump restore disables triggers only for the data load, then checks counts;
  - the drill never touches the live database;
  - retention is 30.
- **L1-observability:**
  - every alert names a metric that exists;
  - the 80%-of-trigger thresholds match ADR 0032;
  - the monitor role is read-only;
  - no third-party client-side code in dashboards.
- **L1-status:**
  - probes come from the second region;
  - the page is static and self-hosted;
  - no proprietary paging required.
- **M1-gifts-refunds:**
  - the partial unique index holds against direct inserts;
  - the 24 h window applies to gifts only;
  - auto-refunds are idempotent;
  - "outcome unknown" never double-refunds;
  - the ledger balances;
  - treasurer actions are audited;
  - the receipt email has no PII in logs.
- **M1-connect:**
  - one transfer per recipient, with an idempotency key;
  - a reversal returns to the payable through a ledger reversal;
  - nothing moves with the manual adapter;
  - no live key path.
- **M1-coop-money:**
  - a share purchase posts per the bylaws;
  - refunds follow ADR 0020;
  - patronage payouts go manual first;
  - `manual_shares` is still the default.
- **R0-release-prep:**
  - the from-release mode verifies signatures and checksums like `verifying.md`;
  - the changelog covers batches 2–8;
  - the docs cover every service added since rc.2.
- **B8-server:**
  - the lapsed-ban event fires once, never twice with the sweep;
  - the giveaway export has pseudonyms only where the brief says;
  - the federation events are internal, not `channel.update`;
  - the archive cleanup never deletes an import in progress;
  - Twitch data is cleared, not the audit row.
- **B8-web:**
  - house primitives;
  - 320 px;
  - `en` and `es`;
  - no remote content in panels (sanitized markdown);
  - the grace bet is refused server side all the same.
- **B8-player:**
  - room-sync targets are unchanged (Chromium under 500 ms, WebKit under 1 s);
  - `dvrSwitchTo` never moves origin → relay;
  - DVR still never served by the CDN.
- **B8-harness:**
  - every shard is under ~12 min;
  - no step was lost in the `e2e-relay` split;
  - the jury cleanup touches only harness rows.

**CI on `main` is the gate:**

- **Never run locally:** `bun run verify`, `verify:full`, harness scenarios, image rebuilds or
  `podman compose`. The one exception is a targeted check to debug a specific CI failure.
- **Reading failures:** read a failed job with `gh api --allow-escape-sequences repos/abolishus/commonair/actions/jobs/<id>/logs`
  and strip escapes with `sed 's/\x1b\[[0-9;]*m//g'`.
- **Which run:** watch the **`ci` workflow** run (`gh run list --branch main --workflow ci`).
- **Reruns:** use `gh run rerun <run> --failed` for infrastructure flakes once the run has
  completed. Do not push while a run with harness shards you need is still in progress.
- **Product failures:** hand a product-looking failure to an agent with a precise brief.

**Lessons from batches 6 and 7 (put them in every agent's brief):**

- Merge by commit sha, not branch name, and check that each merge landed.
- Raw SQL in the harness: timestamps go through `harness/src/w2/sql-time.ts`, and Bun.SQL arrays
  through `sql.array`.
- Read env through `loadEnv`, never `schema.parse(process.env)`.
- Harness expectations follow the seeded defaults. That includes the payout minimum, `vod_enabled`
  false, `jury.enabled` false, and `GIVEAWAYS_ENABLED`, `FEDERATION_ENABLED` and
  `TWITCH_IMPORT_ENABLED` all false. Turn each on explicitly in its overlay or step.
- Cross-unit crypto or key purposes come from one shared constant. Batch 7's N4 units encrypted
  and decrypted under different purposes until `FEDERATION_KEY_PURPOSE`.
- `vp fmt` every touched file. Write `es` with every new English key.
- **Flake watch list:**
  - `services/media` `clock-mediamtx.int` "fMP4 times are the SRT timeline";
  - `media.int` "T0 live";
  - `packages/moderation` ONNX;
  - "transcode ladder starts above the viewer threshold" (fixed once as a race, `a8a95426`).

  Rerun once. If one repeats, brief an agent. R0's "ten green main runs" rule counts them.

**Open for the user:**

- **U1–U6, which block the contract step.**
- The batch 7 visual checks.
- The real-Helix smoke test.
- The real Mastodon follow.
- The real-server track (U5).
- The L1 items that are the user's own.
- The post-launch review list in the README.
