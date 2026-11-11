<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# S1-j moderation: live moderation at 0.05 core per stream

You are implementing unit S1-j for CommonAir (repo: /Users/joshe/Repos/bcon). Before you start,
read:

- AGENTS.md, PLAN.md and docs/architecture.md.
- [ADR 0006](../../../docs/decisions/0006-automated-moderation.md), all of it. Its guarantees are
  the fixed part of this unit.
- [ADR 0041](../../../docs/decisions/0041-launch-scale.md), decisions 2, 3 and 5.
- `.claude/briefs/s1/launch-contract-step.md`: `WORKER_QUEUES` (§2) and the metric names (§3.9).
- S1-i's results in `docs/operators/capacity.md` ("Cost per stream and per viewer") and its CPU
  profiles, if they exist when you start. They say which half of the cost to attack first.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 1**: work in your own git worktree, on branch
`s1/j-moderation`, cut from the contract step's sha. S1-e, S1-f and S1-n run beside you.

## Why

Live moderation costs about 0.2–0.25 core for every live stream, which is 200–250 cores at the
launch target of 1,000 streams. The target is 0.05. The path today, per sample, every
`MODERATION_SAMPLE_SECONDS` (10 s) per stream:

1. `liveCapture` (`services/media/src/moderation/sampler.ts:133`) spawns an ffmpeg that connects
   to RTSP, waits for a keyframe, decodes, and encodes a PNG of up to 1024 px.
2. `decodeImage` (`packages/moderation/src/frames.ts:128`) spawns a **second** ffmpeg to turn
   that PNG into luma 512² and RGB 384².
3. Hash matching (PDQ) runs in media (`scanLiveFrame`, `moderation.ts:296`).
4. With no match, the RGB frame (about 440 kB) goes to Valkey as `moderation:frame:<id>` and a
   `MODERATION_JOBS.scan` job goes on `QUEUES.moderation`.
5. The worker classifies it with ONNX (`services/worker/src/jobs/moderation-scan.ts`,
   `services/worker/src/moderation/scan.ts:54`), one frame per job.

So the classifier already runs outside the media hosts. What is missing is a cheap capture, a
classifier that batches, a worker that can run as a moderation-only pool, and a lag metric for
the scaler.

## You own (write only these)

- `services/media/src/moderation/**` and `services/media/tests/moderation*` (with
  `tests/helpers/moderation.ts`).
- `packages/moderation/**`.
- `services/worker/src/moderation/**`, `services/worker/src/jobs/moderation-scan.ts`, and the
  worker's queue selection (the place `services/worker/src/worker.ts` or `main.ts` decides which
  queues to consume), with the worker tests named `moderation-*`.
- `docs/operators/moderation-capacity.md` (new).

**Read-only:** `services/media/src/session.ts` (S1-e's; it constructs `LiveSampler` at `:48-62`,
so keep that constructor's shape or send a contract request with the exact diff),
`packages/contracts/**`, `packages/config/**`, `infra/**`, `scripts/**`.

## Contracts you must honor

- **ADR 0006 does not get weaker.** The sample interval, the hash lists, the classifier and its
  thresholds, the T0 path (kick, sealed evidence, `MODERATION_JOBS.t0`) and the startup
  failures (key import, hash list load) all behave as today. The same frame feeds the hash
  match and the classifier.
- **No personal data in new metrics or logs**, and no frame bytes anywhere but Valkey with a TTL
  and sealed evidence.
- `WORKER_QUEUES` and the metric names come from the contract step. Do not rename them.
- The sampler reads the node's own MediaMTX (`MEDIAMTX_RTSP_URL`), as today.

## Build

1. **One process per sample, at most.** Replace the two ffmpeg spawns with a path that produces
   both raw outputs (luma 512², RGB 384²) from one decode. Measure these and keep the cheapest
   that passes the equivalence tests:
   - a single ffmpeg per sample writing both raw planes (two outputs or one `split` filter);
   - one long-lived ffmpeg per stream that decodes keyframes only and emits a frame per
     interval;
   - one long-lived reader per media node serving every stream on it.
     A long-lived reader must survive a publisher reconnect, stop when the broadcast ends, and
     never deliver a frame older than one interval. Record the measurements in
     `moderation-capacity.md`.
2. **Capture failures.** Today a failed capture is counted, logged and retried after 1 s
   (`sampler.ts:90-100`), and the broadcast continues unsampled. Keep that, and add
   `moderation.capture.duration`, plus an alertable gauge of streams with no successful sample
   for more than 3 intervals. Whether a stream that cannot be sampled for a long time should be
   stopped is ADR 0006's decision, not yours: report what you observe as a question.
3. **Batched classification.** The worker takes up to B frames per inference (default from
   measurement) with a short maximum wait, so latency stays under one sample interval. Verdicts
   stay per frame, and a batch that fails is retried frame by frame.
4. **Smaller hand-off.** Send the classifier input at the size the model needs, in the cheapest
   lossless form you can show is bit-identical after decode, so Valkey traffic per sample drops.
   Keep the 60 s TTL.
5. **Moderation-only workers.** With `WORKER_QUEUES=moderation` a worker consumes only
   `QUEUES.moderation`, loads the model, and runs no schedulers, outbox or other queues. With
   `all` (the default) behaviour is unchanged. A worker whose list excludes `moderation` does
   not load the model.
6. **Lag instead of silent drops.** Today a backlog over 3× the live broadcast count drops
   classifier jobs (`moderation.ts:382`). Keep the bound as a last resort, and emit
   `moderation.sample.lag` (capture to verdict) so the scaler adds workers first. Count every
   drop (`moderation_classifier_dropped_total` exists).
7. **`moderation-capacity.md`**: cores per stream before and after, by half (capture,
   classifier), frames per second one worker core classifies, the batch size chosen and why, and
   the sizing rule for the moderation pool.

## Edge cases

- A stream whose keyframe interval is longer than the sample interval.
- A publisher reconnect inside the reconnect grace, and a broadcast that ends mid-capture.
- A portrait or tiny source, and one larger than 1080p.
- A batch with one undecodable frame.
- The worker restarting with frames in Valkey that have expired.
- Two moderation workers taking the same job (BullMQ's guarantee: at-least-once, verdict writes
  idempotent). Prove the handler is idempotent.

## Tests you must add

- **Equivalence, the main test:** for a fixture set of frames and sources, the new capture
  yields the same PDQ hash and the same classifier input (bit-identical, or within a stated
  tolerance that you justify against the thresholds) as the old path. Keep the old path in a
  test helper for this.
- Unit tests for batching (size, timeout, per-frame fallback), queue selection for each
  `WORKER_QUEUES` value, and the lag metric.
- Integration tests with real ffmpeg and Valkey (`*.int.test.ts`): reconnect, end mid-capture,
  expired frame, duplicate job.
- The existing media and worker moderation tests still pass.

## Reviewer focus

- No ADR 0006 guarantee weakened; the T0 path untouched or proven equivalent.
- Hash and classifier see the same frame.
- A long-lived reader cannot leak processes or deliver stale frames.
- A worker without the moderation queue never loads the model; one with only that queue runs
  nothing else.

## Done means

Follow `.claude/briefs/_done-means.md`: `bun run test` and `bun run test:int` in
`packages/moderation`, `services/media` and `services/worker` (one package at a time), `bunx tsc
--noEmit` for each, lint, format and `reuse lint`. `git status` shows only your paths. Commit
with `git commit -s`.

Your final message lists: cores per stream before and after as you measured them locally (and
that the real number comes from S1-i's run on DigitalOcean), test counts, contract requests, the
open question on unsampleable streams, and the command for the user to see the lag metric move.
