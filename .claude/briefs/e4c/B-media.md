<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E4c unit B, media moderation** for CommonAir (repo: /Users/joshe/Repos/bcon).
Read AGENTS.md, PLAN.md, docs/architecture.md and `.claude/briefs/e4c/_common.md` first (all of
it, especially the SAFETY RULES), then `docs/testing/e4c-selectors.md` in full (rows Sampling,
T0 live, T0 VOD/clip), ADR 0006 Q1, Q4 and Q6, `services/media/README.md` and the current
`services/media/src/safety/` (`enforce.ts`, `hashmatch.ts`, `quarantine.ts`) and
`thumbnails.ts`, `jobs.ts`, `vod/`, `clips.ts`. Do not look outside the repository.

**SAFETY RULES (repeated; absolute):** never obtain, generate, download, describe or handle real
CSAM, NCII or other illegal material, and never search for it. Tests use only the synthetic
fixtures in `packages/moderation/fixtures/` and generated patterns. Never download or embed
industry hash lists. Logs carry ids, categories, tiers, scores, distances and list versions only:
never frames, bytes, hashes of non-matching frames, keys, URLs or personal data. The pipeline
cannot be switched off: no env, setting or code path may skip sampling or PDQ, and bad config
refuses to start. No ban from a classifier score (media never bans anyway). Media kicks first.

This unit is on the **T0 path**: it gets a second, security-focused review.

## You own (write only these)

- `services/media/src/safety/**` (rewrite: `quarantine.ts` and the SHA-256 `hashmatch.ts` go
  away; media no longer writes suspensions or moves objects, the worker does), new
  `services/media/src/moderation/**`, `services/media/src/thumbnails.ts`, the VOD/clip
  finalize paths in `services/media/src/vod/**`, `services/media/src/clips.ts` and
  `services/media/src/jobs.ts` (only to add the pre-publish scan and the moderation producer),
  `services/media/src/lifecycle.ts`/`session.ts`/`service.ts`/`context.ts`/`main.ts` (only to
  start and stop the sampler per broadcast and wire dependencies), `services/media/src/env.ts`
  (add `moderationEnv`, `evidenceSealEnv`; drop `HASH_MATCH_*` use), `services/media/README.md`
  ("Moderation" section), `services/media/tests/**` for your tests (edit existing safety tests
  that you replace).
- `services/media/package.json`: only to add `"@commonair/moderation": "workspace:*"`.

## Contracts you must honor (read-only for you)

- `@commonair/moderation`: `pdqHash` (via `decodeImage`/frame bytes), `createHashMatcher`,
  `loadHashListFile`, `staticHashList`, `watchHashListFiles`, `sampleVideoFrames`,
  `encodeImage`, `importSealingKey`, `plaintextSha256`, `MODERATION_CONSTANTS`,
  `parseThresholds`, `effectiveSampleSeconds`. Until unit A merges, the PDQ/list/ffmpeg bodies
  throw; write your code and unit tests against fakes of the interfaces, then merge `main` and run
  the integration tests for real.
- `QUEUES.moderation`, `MODERATION_JOBS.scan`/`t0`, `ModerationScanJob`, `ModerationT0Job`,
  `SealedEvidence`, `t0JobId`, `KEYS.moderationFrame` (TTL `MODERATION_FRAME_TTL_SECONDS`).
- Tables you read: `local_hash_list` (active rows, the always-loaded `pdq:local` list; reload it
  every sample interval or on a cheap change check, version `local:<count>:<newest id>`),
  `governance_settings` (`moderation.thresholds` for `sampleSeconds`), `broadcasts`, `vods`,
  `clips`. Media **writes no moderation tables**.

## Build

1. **Startup (fail closed).** Load `moderationEnv` and `EVIDENCE_PUBLIC_KEY` (import it with
   `importSealingKey` at start; failure → exit). Load both operator lists (a parse error at
   startup → refuse to start; at reload → keep the last good list and log the category and line
   number) and the local list. Log one line with list versions and sizes (no hashes).
2. **Live sampling** per live broadcast (the existing session lifecycle): first frame within
   `STREAM_START_SAMPLE_SECONDS` of publish, then every `effectiveSampleSeconds(env, setting)`
   (re-read the setting each interval), independent of the 60 s thumbnail. One ffmpeg reader per
   broadcast producing both raw luma 512² and RGB 384² for the same frame (reuse the existing
   internal RTSP reader conventions). For each frame: PDQ in media; if quality ≥ 50, match. No
   match → put the RGB bytes at `KEYS.moderationFrame(frameId)` with the TTL and enqueue
   `scan` `{frameId, broadcastId, channelId, capturedAt, pdq, quality}` (pdq null when quality
   < 50). If the moderation queue's waiting count exceeds `CLASSIFIER_BACKLOG_INTERVALS` worth of
   frames for all live broadcasts, drop the classifier job (counter `moderation_classifier_dropped_total`,
   warn log) but **never** skip PDQ. Metrics: `moderation_frames_total{tier}`-style counters for
   sampled, matched, low-quality, dropped. Nothing is written to S3 or the DB for an unflagged frame.
3. **T0 live** on a match: (1) kick the publisher and stop local workers without finalizing a
   VOD, exactly as `enforce.ts` does now, and add the path to the in-process tainted set so a
   reconnect is refused (keep the existing mediaAuth interplay); (2) encode the matched frame's
   luma and RGB as **PNG** (`encodeImage`), seal each (`SealedEvidence` kind `frame`,
   `pdq`/`pdqQuality` of the luma frame), and enqueue `t0` with `jobId = t0JobId("broadcast",
   broadcastId)`, the list category, distance, quality, `provider`, `listVersion`; (3) retry the
   enqueue with backoff until it succeeds (log `fatal` with ids if it keeps failing; the stream
   stays off air regardless). Off air within two sample intervals of the first matching frame:
   test it with a fake clock.
4. **T0 VOD/clip pre-publish.** Before a VOD or clip is set `ready`: `sampleVideoFrames` every
   `MODERATION_SAMPLE_SECONDS` of its duration (clips: every second), match all frames, then
   publish. A match → the VOD/clip stays unpublished and `t0` is enqueued for subject `vod`/`clip`
   (evidence = the matched frame, sealed). Never publish while the scan is incomplete or failed
   (fail closed: retry the job).
5. **Thumbnails.** A thumbnail is PDQ-checked before it is written; a match is handled as T0 live
   and no thumbnail is written.
6. **Remove the old path.** `quarantine.ts` and `hashmatch.ts` (SHA-256 `stub`) go; the worker
   copies T0 media to the evidence bucket (unit C). Report the `HASH_MATCH_*` env deletion as a
   contract request.
7. README section: what is sampled and when, what is stored (nothing unless flagged), the
   kick-first order, the backlog rule, metrics.

## Tests you must add

- Unit: interval and start-sample scheduling with a fake clock (setting vs env minimum, setting
  change mid-stream), backlog drop never skipping PDQ, kick-before-enqueue order, enqueue retry,
  tainted reconnect refused, sealed payload shape (`ModerationT0Job.parse`), low-quality frames
  classified but not matched, list reload keeps the last good list, startup refuses a bad key or
  a bad list, log hygiene (capture the logger, assert no base64, hex hash of the frame, key or
  URL appears).
- Integration (real Valkey/Postgres/ffmpeg, after A merges): a synthetic H.264 stream of
  `t0-pattern.png` against `fixtures/csam.pdq` → kicked and one `t0` job with sealed evidence that
  opens with a test private key and has the plaintext sha256; a benign pattern → `scan` jobs and
  Valkey frames with the TTL, no `t0`; a VOD containing the pattern is not published and enqueues
  `t0` for the VOD; a clean VOD publishes.

## Done means

See `_common.md` "Done means". Your package: `services/media` (`bun run test`, `bun run
test:int`, `tsc`), lint/fmt on changed paths.
