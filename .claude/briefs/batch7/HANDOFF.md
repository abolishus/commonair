<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Batch 7 handoff prompt

Paste this into a new session started in the repository.

---

You are the orchestrator for CommonAir batch 7: W3 (feature-wins wave 3), N3 (Twitch import) and
N4 (ActivityPub federation), plus the batch 6 follow-ups. Repo: this checkout, branch `main`, at
the batch 7 planning commit or later. Batch 6 (W2) is done: CI green on `8a562d9a` with every job,
on the push run and on a full dispatch run with all eight harness shards.

**Read first:**

- AGENTS.md.
- `.claude/briefs/batch7/README.md`: the gates, decisions (a)–(ad) (final; "user" rows are the
  user's), path ownership, waves, shared rules, milestone checks, follow-ups and post-launch
  review.
- `.claude/briefs/w3/contract-step.md`.
- The twelve unit briefs: `w3/W3-{watch-rooms,portability,giveaways,jury,surge-raids,fair-predictions,dvr-relay}.md`,
  `n3/N3-import.md`, `n4/N4-{api,delivery,web}.md`, `b7/B7-followups.md`.
- `.claude/briefs/next/{W3-feature-wave,N3-twitch-import,N4-federation}.md`.
- `.claude/briefs/_done-means.md`.
- PROGRESS.md "In flight": the batch 6 and batch 7 paragraphs.

**There is no counsel** (decision (h)). Never block on a "counsel" gate: the plan already chose the
conservative option (giveaways and the Twitch import ship off). Add anything new of that kind to the
README's "Post-launch review".

**Do, in order:**

1. **Contract step** (`w3/contract-step.md`) on `main`: implement, then an independent review, then
   fix. Land it as one commit or a short series, push, and wait for CI green.
   - It is the largest contract step so far: ADRs 0037–0039 and two amendments, two migrations,
     contracts, config, `packages/{draw,federation}` and the standing and purge crypto with TS and
     Go vectors, the media-state event writes on every path, seams, stubs, web placeholders, the
     harness `w3` shard and scaffolding, the SDK relicensing, and the notify-shard measurement.
   - Run it as a Workflow with up to six agents on its parts (A)–(F), which touch disjoint files.
     Then integrate and review it whole: a four-dimension review (schema and triggers, crypto and
     vectors, seams and events coverage, web/harness/CI), then fix.
   - Regenerate the self-host key lists (`bun scripts/selfhost/unit-env.ts`). Add `SEED_ROUTES`
     rows for the new routes. Another session owns the seed under `.claude/briefs/seed-full/`, so
     coordinate through the routes file only.
2. **Side task** beside wave 1, touching no unit path: whisper into the release and self-host
   bundle. That means `scripts/release/{images,manifest}.ts` (drop `UNRELEASED_IMAGES`),
   `.github/workflows/release.yml` (the 14 → 15 images count), a `scripts/selfhost/**` option, the
   AVX2 note in the operator guide, and `infra/selfhost/**`. Give it its own commit, with CI green.
3. **Wave 1** with the Workflow tool: W3-watch-rooms, W3-portability, W3-giveaways, W3-jury,
   W3-surge-raids and W3-fair-predictions, on branches `w3/{rooms,portability,giveaways,jury,surge-raids,predictions}`.
4. **Merge wave 1:**
   - **Merge by commit sha, not branch name, and check that each merge landed** (`git log
     --oneline -1 <sha>` is an ancestor of `HEAD`).
   - No two branches may touch one file. Use `git merge --no-ff --signoff <sha>` with the
     `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer.
   - Apply or decline the contract requests (the giveaway rules text and the juror privacy text go
     into `packages/db/src/legal/**` as drafts).
   - Lift `PENDING_W3_*` and `PENDING_B7_IDS` entries as units merge.
   - Push, and wait for CI green.
5. **Wave 2:** N3-import, N4-api, N4-delivery, N4-web, W3-dvr-relay and B7-followups, on branches
   `n3/import`, `n4/{api,delivery,web}`, `w3/dvr-relay` and `b7/followups`. When W3-dvr-relay
   merges, apply its `handler.ts` `captionsReachable` flip for relay pulls (decision (y)) in the
   same push. Merge, push, CI green.
6. **Milestone** (README "Milestone checks"):
   - put the new scenarios in `FULL_REQUIRED`;
   - write the privacy and terms drafts, and bump `PRIVACY_SEED_VERSION`;
   - re-measure the `interact` and `w3` shards;
   - get CI green on a push run and a full `workflow_dispatch` run;
   - write PROGRESS;
   - then plan batch 8 (the next/README order, plus the deferred items).

**Workflow scripts.** Reuse batch 6's, in
`~/.claude/projects/-Users-joshe-Repos-bcon/a7fef824-1175-4b97-a672-f59dfeb5b8e5/workflows/scripts/`:

- `batch6-contract-p1-wf_1b93b19d-260.js` and `batch6-contract-p2-wf_34ac45dc-1b6.js` show the
  contract step split into parallel parts. Change the parts to (A)–(F).
- `batch6-contract-review-wf_983d3161-b52.js` is the four-dimension review. Change the dimensions.
- `batch6-wave1-wf_a117b9af-410.js` and `batch6-wave2-wf_c6b33b0a-094.js` are the wave pipelines.
  Each has an implement schema with worktree, branch, commits and report; per-unit reviewer focus
  via `extra`; and a fix agent that `cd`s into the worktree. Change the units, the base sha and
  the lessons line.
- `batch6-wave1-ci-fixes-wf_f54a5bc3-111.js` and `batch6-wave1-ci-fixes-2-wf_226c5c87-7c0.js` are
  the shape for a CI-fix fan-out.

**Reviewer focus per unit:**

- **watch-rooms:**
  - the age-band trigger holds against direct inserts;
  - unknown age fails closed;
  - mature means adult only, with confirmation;
  - the block check runs both ways, server side;
  - ban inheritance applies mid-room;
  - reports have `channel_id` null and carry the transcript;
  - no room content goes into append-only columns;
  - retention is 30 days, plus the deletion hook;
  - drift targets.
- **portability:**
  - move-link limits;
  - attribution only on new follows;
  - counts exclude excluded follows (trigger-maintained);
  - one moved email per grant, never shown to the creator;
  - the standing statement against the vectors, and the key on the worker only;
  - the import refuses suspension and legal hold;
  - every image goes through `uploadCommit`;
  - `applyBundle` is idempotent and documented.
- **giveaways:**
  - the flag-off refusal everywhere;
  - no paid or points entry expressible;
  - the commit happens before the entries;
  - the reveal hashes to the commitment;
  - the draw against `packages/draw` vectors;
  - salted pseudonyms only;
  - audit rows.
- **jury:**
  - the never-sampled set (T0, NCII, legal hold, `watch_room`, minors);
  - seat eligibility enforced by the trigger;
  - no free text in votes;
  - k = 10 suppression;
  - the seed is committed before selection;
  - no code path changes an outcome.
- **surge-raids:**
  - only verified raiders carry;
  - the TTL matches the surge;
  - an override wins;
  - guard off or `onRaid` off means nothing happens;
  - audit and outbox on begin and end;
  - no chat service change.
- **fair-predictions:**
  - the media-time lock edges and the 30 s bounds;
  - DVR and catching-up refusals;
  - the team refusal (API and trigger);
  - verified-watch required;
  - payouts sum to the pool;
  - resolver audited;
  - points only.
- **N3-import:**
  - no scopes;
  - the token is never stored or logged and is revoked;
  - an account mismatch is refused;
  - fixed hosts and the SSRF guard on image fetches;
  - one import path (`applyBundle`);
  - `panelPaste` strips all HTML;
  - flag and credential gating;
  - hidden under `--no-proprietary`.
- **N4-api:**
  - no outbound fetch in the API;
  - flag gating (404 or `FORBIDDEN`);
  - the actor shape;
  - no icon for mature channels;
  - followers have a count and no items;
  - NodeInfo has no usage;
  - inbox cheap checks only, store and 202;
  - blocks audited and dropping followers.
- **N4-delivery:**
  - draft-cavage against the vectors (digest, date skew, `keyId`/actor);
  - the key fetched through `resolveCallback`;
  - only `Follow`/`Undo`/`Delete` applied;
  - removal and suspension send `Delete`;
  - mature: `sensitive`, no thumbnail;
  - no PII in objects;
  - backoff and the 7-day drop;
  - nothing is sent with a flag off.
- **N4-web:**
  - no remote content loaded (AGENTS.md rule 4);
  - confirm dialogs;
  - house primitives;
  - 320 px;
  - `en` + `es`.
- **dvr-relay:**
  - purge signature verification and refusal;
  - `DeletePrefix` plus tombstones against in-flight fills;
  - removal within 5 s even with no purge (the stale-playlist rule);
  - the CDN never serves DVR;
  - `.vtt` neither counted nor pinned;
  - the relay token binding;
  - receipts count DVR.
- **B7-followups:**
  - the re-score threshold reuses the scorer;
  - no double count after the `modActionCells` change;
  - statements only for actioned resolves and suspends;
  - the sample count only for rehearsals.

**CI on `main` is the gate:**

- **Never run locally:** `bun run verify`, `verify:full`, harness scenarios, image rebuilds or
  `podman compose`. The one exception is a targeted check to debug a specific CI failure.
- **Reading failures:** read a failed job with `gh api --allow-escape-sequences repos/abolishus/commonair/actions/jobs/<id>/logs`
  and strip escapes with `sed 's/\x1b\[[0-9;]*m//g'`. Harness artifacts upload on failure.
- **Which run:** watch the **`ci` workflow** run, not CodeQL or scorecard (`gh run list --branch
  main --workflow ci`).
- **Reruns and pushes:** use `gh run rerun <run> --failed` for infrastructure flakes once the run
  has completed. Do not push while a run with harness shards you need is still in progress.
- **Product failures:** hand a product-looking failure to an agent with a precise brief (the
  failing check, its data, the code paths, "reproduce in a unit test first").

**Lessons from batch 6 (put them in every agent's brief):**

- Merge by commit sha, not branch name, and check that each merge landed.
- Raw SQL in the harness: timestamps on the Drizzle-wrapped client go through
  `harness/src/w2/sql-time.ts`, and Bun.SQL arrays through `sql.array`.
- Read env through `loadEnv`, never `schema.parse(process.env)`. A blank optional value, such as
  `INFRA_COST_MODEL`, broke the rollup job.
- Harness expectations follow the seeded defaults: the payout minimum, `vod_enabled` false, the
  multi-category viewbots. Batch 7 adds `jury.enabled` false, `GIVEAWAYS_ENABLED` false,
  `FEDERATION_ENABLED` false and `TWITCH_IMPORT_ENABLED` false. Turn each on explicitly in its
  overlay or step.
- `vp fmt` every touched file, including one-line call-site edits at integration.
- Write `es` with every new English key (`REQUIRED_LOCALES = ["es"]`). Keep instance and channel
  content as content, not literals, for the `en-XA` scan.
- **Flake watch list:** `services/media` `clock-mediamtx.int` "fMP4 times are the SRT timeline"
  (240 s timeout) and `media.int` "T0 live" ("timed out waiting for source ready in MediaMTX"),
  once each; plus batch 5's `packages/moderation` ONNX test and `services/media` "transcode ladder
  starts above the viewer threshold". Rerun once. If one repeats, brief an agent.

**Open for the user (don't block on them):**

- Accept ADRs 0037–0039 and the 0016 amendment.
- Visual checks of the new pages under `es` and `en-XA`.
- A real-Helix smoke test before the Twitch import is turned on.
- A real Mastodon follow against staging before federation is turned on.
- The post-launch review list in the README.
