<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Batch 8 handoff prompt

Paste this into a new session started in the repository.

---

You are the orchestrator for CommonAir batch 8. It covers:

- R0's release prep toward `v0.1.0`;
- S1 stage 1 (S1-d, S1-b, S1-h), which is **launch-critical**: our instance launches on managed
  Postgres and Valkey (U4);
  - this is a deployment choice for our instance: in `selfhost.sh` the bundled Postgres and Valkey
    stay the default with full support, and external services are an added option;
- M1 on stripe-mock;
- L1's engineering (observability and the status page);
- the batch 6 and batch 7 follow-ups.

Repo: this checkout, branch `main`. Batch 7 is done (PROGRESS "Batch 7 done", `43ae60dc`, push and
dispatch runs green). The user answered U1–U6 on 2026-11-02. The plan is final, and the contract
step and all twelve briefs are written. **Start the contract step directly.**

**Read first:**

- AGENTS.md.
- `.claude/briefs/batch8/README.md`:
  - the decisions: U1–U6 answered, (a)–(r) orchestrator defaults;
  - "What U4 changes";
  - the units and gates, re-checked at `4e92eefe`;
  - the final path ownership and the conflicts checked;
  - the milestone checks, the follow-ups, the open items and the post-launch review.
- `.claude/briefs/b8/contract-step.md`. Its §0 lists where the code differs from the plan.
- The twelve briefs listed in the README's "Briefs".
- ADR 0007, ADR 0014, ADR 0020, ADR 0025 and ADR 0032. ADRs 0037–0039 are accepted 2026-11-02.
- `.claude/briefs/batch7/HANDOFF.md` for the format, and `.claude/briefs/_done-means.md`.

**There is no counsel** (batch 7 decision (h)). Never block on a "counsel" gate. Take the
conservative default, and add the call to the README's "Post-launch review". M1 never takes a live
key (decision (b)).

**Do, in order:**

1. **Contract step** (`b8/contract-step.md`) on `main`: implement, then an independent review, then
   fix.
   - Run it as a Workflow with four agents on parts (A)–(D), which touch disjoint files.
   - **Part (A) is the re-plan point** (decision (a)). If any step needs a superuser, stop and
     re-plan S1-b and S1-h with the user before wave 1. That includes the owner-only restore
     (§1.3) and the private-CA client TLS (§1.4).
   - Part (B) ends with the database security review of `0049_b8_protections.sql`, done as
     `0002_protections_hardening.sql` was: every proven bypass gets a regression test.
   - Regenerate the self-host key lists (`bun scripts/selfhost/unit-env.ts`).
   - Push, and wait for CI green. Write "Batch 8 contract step merged" in PROGRESS.
2. **Wave 1** with the Workflow tool: S1-b external, L1-observability, M1-gifts-refunds,
   M1-connect, B8-server and B8-web, on branches `s1/b-external`, `l1/observability`,
   `m1/gifts-refunds`, `m1/connect`, `b8/server` and `b8/web`. Each is cut from the contract
   step's sha, in its own worktree.
3. **Merge wave 1:**
   - **Merge by commit sha, not branch name, and check that each merge landed** (`git log
     --oneline -1 <sha>` is an ancestor of `HEAD`).
   - No two branches may touch one file. Use `git merge --no-ff --signoff <sha>` with the
     `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer.
   - Apply or decline the contract requests:
     - S1-b's CI matrix row for `--state external`;
     - L1-observability's `compose.yaml` collector env and any image rows;
     - wiring `e2e-metrics.ts` into the e2e;
     - any harness test hooks.
   - Lift `PENDING_B8_*` entries and `PENDING_B8_IDS` as units merge.
   - Push, and wait for CI green.
4. **Wave 2:** S1-h backups-ext, M1-coop-money, R0-release-prep, L1-status, B8-player and
   B8-harness, on branches `s1/h-backups-ext`, `m1/coop-money`, `r0/release-prep`, `l1/status`,
   `b8/player` and `b8/harness`, from `main` after wave 1.
   - When S1-h merges, wire `e2e-dump.ts` into `scripts/selfhost/e2e.ts` and apply its
     `install_units` timer lines.
   - When B8-harness merges, apply its `shards.ts`, `registry.ts` and `w3/steps.ts` diffs, and wire
     B8-player's `relay-dvr-switch` into the new `relay-dvr` scenario.
   - Merge, push, CI green.
5. **The agent track** (U5), beside both waves, **once the user has created the staging-only
   DigitalOcean project and its `doctl` token**. Until then, list it as waiting and do not block
   the waves on it. With the token:
   1. S1-d's managed-cluster check (contract §1.5);
   2. S1-a's capacity sweep, for the production droplet size;
   3. after S1-h, the timed restore into a fresh managed cluster;
   4. `failover` against the managed clusters;
   5. a timed app-droplet rebuild from tofu.
      Tag every droplet and cluster, destroy them at the end of each run, and never touch production.
      Record the numbers in ADR 0032 §1.
6. **Milestone** (README "Milestone checks"):
   - re-measure every shard;
   - write the privacy and terms drafts (receipt email, Connect payouts, card share purchases, the
     Twitch data expiry, and DigitalOcean as database processor), and bump `PRIVACY_SEED_VERSION`
     and `TERMS_SEED_VERSION`;
   - get CI green on a push run and a full `workflow_dispatch` run;
   - write PROGRESS.
   - Then, per U2 and U3: cut rc.3 from that commit, run R0 §3 on the staging project (agent
     track), have the user do the visual checks on rc.3, and tag `v0.1.0` from the same commit.
     `ROADMAP.md` then says Phase 1 shipped.
   - Then plan batch 9: statement `v: 2` if the ADR 0014 amendment is accepted, S1-f once stage 1
     is live, N2's Arabic, and the carried items. The two-week minor cadence starts at `v0.1.0`.

**Workflow scripts.** Reuse batch 7's or batch 6's. The batch 6 ones are in
`~/.claude/projects/-Users-joshe-Repos-bcon/a7fef824-1175-4b97-a672-f59dfeb5b8e5/workflows/scripts/`:

- the contract-step parts;
- the four-dimension review. Change the dimensions to:
  - schema, ledger rules and triggers;
  - money seams and stripe-mock;
  - self-host, TLS and infra;
  - web, harness and CI.
- the wave pipelines (implement, review, fix in the same worktree);
- the CI-fix fan-out.

Change the units, the base sha and the lessons line.

**Reviewer focus per unit:**

- **Contract step:**
  - (A) proves every step as a `CREATEROLE` owner with no superuser, under `verify-full`;
  - the owner-only restore re-enables triggers and catches a doubled `follower_count`;
  - the monitor role holds no write right;
  - the CA env vars change nothing when unset.
  - (B):
    - the gift index holds across two connections;
    - transfer and patronage status machines refuse regressions;
    - `reversed_cents` never exceeds the amount;
    - every new posting balances.
  - (C) the federation events are internal; `verify.me` never carries the salt.
  - (D) production tofu has `enable_managed_state = true`, and `check.sh` passes.
- **S1-b external:**
  - bundled Postgres and Valkey stay the default, and the bundled install, upgrade, `status`,
    rollback and e2e behave exactly as before;
  - switching modes is refused with a clear message;
  - TLS is really verified (`verify-full`, `rediss://`, the private CA mounted), and the insecure
    flags are explicit and recorded;
  - no bundled unit is installed, or ordered after, for an external service;
  - `upgrade` keeps the choice and runs `migrate` once;
  - the preflight checks the connection budget and writes nothing;
  - no secret is in a unit file, a log, `status` output or a command line;
  - the e2e covers both Valkey auth models and shows no `CONFIG`/`ACL` at runtime.
- **L1-observability:**
  - every alert and panel names a metric that exists;
  - the 80%-of-trigger thresholds match ADR 0032;
  - the burn rules read the `slo_target` label, 0.999 for production;
  - remote collection uses verified TLS and the read-only monitor role, whose password is in no
    config or log;
  - no third-party client-side code in the dashboards;
  - the DigitalOcean metrics scrape is optional and off.
- **M1-gifts-refunds:**
  - the partial unique index holds against direct inserts, and the `CONFLICT` is in addition to it;
  - the 24 h window applies to gifts only;
  - auto-refunds are idempotent and never reactivate a subscription;
  - "outcome unknown" never double-refunds, and the reconciler never posts to the ledger;
  - the ledger balances;
  - treasurer actions are audited;
  - the receipt sends once, with no PII in logs.
- **M1-connect:**
  - one transfer per payout row, with a key stable across retries;
  - a reversal returns to the payable through a ledger reversal;
  - a definite failure cancels through `payoutCancel`;
  - nothing moves with the manual adapter, and there is no live key path;
  - held payees are never paid;
  - no name or email is in Stripe metadata.
- **B8-server:**
  - the lapsed-ban event fires once, never twice with the sweep;
  - the giveaway export holds only the caller's own rows, with no salt;
  - the federation events are internal, never `channel.update`, and the API queues no delivery;
  - the archive cleanup never deletes an import in progress or a fresh upload;
  - Twitch data is cleared, but not the audit row;
  - the statement email cites no case that does not exist.
- **B8-web:**
  - house primitives, 320 px, `en` and `es`;
  - panel text stays text, links are `nofollow ugc`, and nothing remote loads;
  - the grace bet is still refused server side outside its rules;
  - the replay cap bounds memory;
  - no username on the verify page (decision (n)).
- **S1-h backups-ext:**
  - the bundled WAL-G backups and restore are unchanged, and both modes have a drill;
  - the restore disables only user triggers, only for the data load, then checks counts;
  - the drill never touches the live database;
  - retention is 30 and never deletes below 30;
  - dumps are checksummed and private, with no row data in logs;
  - `managed-services.md` matches the tofu module and is what production follows.
- **M1-coop-money:**
  - a share purchase posts per the bylaws and activates membership in the same transaction;
  - refunds follow ADR 0020 and the shared guard;
  - patronage payouts go manual first, with two approvers, and never overpay;
  - `manual_shares` and `shares.cardPayments = false` are the defaults.
- **R0-release-prep:**
  - the from-release mode verifies signatures and checksums exactly as `verifying.md` says;
  - the changelog covers Phases 1–5 and batches 1–8 in user terms;
  - every documented `selfhost.sh` flag exists;
  - the flake log matches the run history.
- **L1-status:**
  - probes run from the second region;
  - the down-alert path does not depend on the app droplet;
  - the page is static and self-hosted;
  - no proprietary paging, and only `blackbox_exporter` added;
  - no secret in tofu state;
  - every `runbook` label resolves.
- **B8-player:**
  - room-sync targets are unchanged (Chromium under 500 ms, WebKit under 1 s);
  - a client cannot push the room past the live edge;
  - `dvrSwitchTo` never moves origin → relay or relay → relay;
  - DVR is still never served by the CDN.
- **B8-harness:**
  - every shard is under ~12 min, on measured numbers;
  - no step was lost in the `e2e-relay` split, and each scenario runs alone;
  - the jury cleanup touches only harness rows;
  - the rate-limit match works in `en`, `es` and `en-XA`.

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
- Harness expectations follow the seeded defaults: the payout minimum, `vod_enabled` false,
  `jury.enabled` false, `shares.cardPayments` false, and `GIVEAWAYS_ENABLED`, `FEDERATION_ENABLED`
  and `TWITCH_IMPORT_ENABLED` all false. Turn each on explicitly in its overlay or step.
- Cross-unit crypto or key purposes, and cross-unit names (the §3.7 secret and env names, metric
  names such as `commonair_restore_drill_seconds`), come from one written contract. Batch 7's N4
  units encrypted and decrypted under different purposes until `FEDERATION_KEY_PURPOSE`.
- Two units in one wave never share a file, and that includes i18n namespaces and email catalogs:
  batch 8 gives M1-connect its own `m1-connect`.
- `vp fmt` every touched file. Write `es` with every new English key.
- **Flake watch list:**
  - `services/media` `clock-mediamtx.int` "fMP4 times are the SRT timeline";
  - `media.int` "T0 live";
  - `packages/moderation` ONNX;
  - "transcode ladder starts above the viewer threshold" (fixed once as a race, `a8a95426`);
  - a chat-filter timing test (passed on rerun in the batch 7 dispatch run).

  Rerun once. If one repeats, brief an agent. R0's "ten green main runs" rule counts them in
  `docs/operators/flakes.md` (R0-release-prep).

**Open for the user:**

- **Create the staging-only DigitalOcean project, with a spending cap, and a `doctl` token scoped
  to it (U5).** The agent track waits for it, and stage 1 cannot be called launch-ready without it.
- The batch 7 visual checks, and from now on the visual checks on each release candidate (U3).
- The real-Helix smoke test and the real Mastodon follow.
- The L1 items that are the user's own: the legal entity, the DMCA agent, CSAM lists, staffing and
  on-call, the egress budget, and an external security review.
- The post-launch review list in the README, now including Connect tax details and DigitalOcean as
  database processor.
