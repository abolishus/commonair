<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W2-captions: open captions (live WebVTT, VOD track, creator corrections)

You are implementing unit W2-captions for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/batch6/README.md` (decisions (c), (g),
(j), (n), (o), (p), path ownership and shared rules are binding), `.claude/briefs/w2/contract-step.md`
(§1.2 channel `captions` settings, §1.3 `vods.captions` / `Vod.captions`, §2.1 caption tables, §3
`packages/chat-filter`, §4 seams, §6 the `captions` shard), `docs/product/feature-wins.md` §4.5,
`docs/decisions/0011-caption-models.md` (all six decisions are your spec), ADR 0012 part 1 (media
clock), `docs/testing/w1-selectors.md` "Player seam", `docs/testing/w2-selectors.md` and
`.claude/briefs/_done-means.md`. Do not look outside the repository. **Wave 1**, own git worktree,
branch `w2/captions` from the contract step's sha (`git merge main` first if main moved). W2-dvr runs
beside you: it imports `rewritePlaylist` from your `services/origin/src/playlist.ts` read-only (keep
its signature) and owns the DVR fields of `services/api/src/routes/playback.ts`. Paths checked at
`8fc2c974`; recheck line numbers against your base.

## Why

Twitch has no native live captions. Ours are open and self-hosted (whisper.cpp, MIT weights pinned
by digest), off by default with the cost published, masked rather than censored, and correctable on
the VOD, so a Deaf viewer can turn on CC on any opted-in stream (feature-wins §4.5).

## You own (write only these)

- `services/media/src/captions/**` (the contract step's `index.ts` registers a no-op session hook)
- `services/origin/src/captions.ts` (registered 404 stub) and `services/origin/src/playlist.ts`
- `packages/captions/**` (the model entry, cue/VTT/WER helpers, Valkey key shapes), `scripts/fetch-model.ts`
- `infra/containers/whisper.Containerfile`, the `whisper` service in `compose.yaml` (that block only),
  `harness/compose.w2-captions.yaml`, your entry in `infra/image-licenses.json`
- `services/api/src/captions/**` (`captionTracksFor`, `vods.captions.{get,update}` handlers; see
  "Contract requests" if the contract step did not create these stubs)
- `apps/web/src/player/captions*`, `apps/web/src/routes/_studio/captions.tsx` (content),
  `apps/web/src/i18n/locales/{en,es}/w2-captions.json`, `apps/web/src/i18n/keys/w2-captions.gen.ts`
- `harness/scenarios/captions.ts` (fill the stub), `harness/src/w2/captions/**`, `harness/fixtures/captions/**`;
  tests in `services/{media,origin,api}/tests/captions*`, `apps/web/tests/captions*`, `harness/tests/w2/captions*`

Read-only: `services/media/src/{service,session,hooks}.ts`, `transcode/slots.ts`, `ffmpeg/args.ts`,
`clock/**`, `vod/**`; `services/origin/src/{origin,handler,paths,vod}.ts`; `services/api/src/routes/{playback,vods}.ts`;
`apps/web/src/player/{controller.ts,player.tsx,dvr*}`; `packages/{contracts,db,config,chat-filter,safe-regex}/**`;
`relay/**`. Anything else is a **contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- `PlaybackStart.captions: {language, label, url}[]` (`entities.ts:276`), filled through your
  `captionTracksFor(broadcast)`; `Vod.captions`; `vods.captions.{get,update}`.
- Tables `broadcast_caption_tracks` (`CAPTION_TRACK_STATUSES`), `caption_edits` (`editor_user_id`).
- Channel setting `captions {enabled, spokenLanguage, maskWords}`; governance `captions.defaultEnabled`
  (seeded false; a channel's own choice wins); env `CAPTIONS_MAX_STREAMS` (default 2, 0 = off), `WHISPER_URL`.
- Media session hook registry `{onStart(session), onEnd(session)}`; `broadcasts.kind` (no captions
  for `rehearsal`, decision (g)); origin route registry with the `vtt` request kind (`paths.ts:21`
  already accepts `.vtt`); `@commonair/chat-filter` (`applyFilters`, `CompiledFilter`, `FILTER_BUDGET_MS`).

## What is there today (verified at `8fc2c974`)

`playback.start` returns `captions: []` (`services/api/src/routes/playback.ts:248`). Seam:
`setTargetLatency` (`apps/web/src/player/controller.ts:298`), `onTextTrack` (`:321`); never edit
`controller.ts`. SRT reader `internalSrtUrl` (`services/media/src/ffmpeg/args.ts:41-47`), media clock
`services/media/src/clock/*`, `SlotLimiter` (`transcode/slots.ts:22`). `synthesizeMultivariant`
(`services/origin/src/playlist.ts:176`) namespaces `SUBTITLES` groups (`:159`); the relay rewrites every
`URI=`, `EXT-X-MEDIA` included (`relay/internal/hls/rewrite.go:111-150`). `scripts/fetch-model.ts` fetches
one `MODEL` (`packages/moderation/src/model.ts:10-18`); CI caches it (`action.yml:146-156`).

## Build

1. **Model.** `packages/captions/src/model.ts`: `CAPTIONS_MODEL` = `ggml-base-q5_1.bin` from the
   whisper.cpp ggml repository at a pinned revision, sha256 **required** (fetch refuses null or a
   mismatch), size, and a comment naming the MIT license file you read at that revision.
   `fetch-model.ts` gains a model selector matching the flags the contract step put in
   `action.yml` (default unchanged: the classifier only; the classifier's null-digest tolerance stays).
2. **Sidecar.** `whisper.Containerfile`: base image pinned `name:tag@sha256:…`, whisper.cpp built from
   source at a pinned tag (record tag and commit), only the server binary copied to a non-root final
   stage, weights mounted read-only (never baked in), 2 threads, a healthcheck. Compose `whisper`:
   internal network only, no published port. `image-licenses.json` entry notes the added MIT binary.
   `harness/compose.w2-captions.yaml`: mounts the weights, sets `WHISPER_URL`, and
   `CAPTIONS_MAX_STREAMS=1` so the capacity step needs only two streams.
3. **Worker (`services/media/src/captions/**`).** `onStart`: skip rehearsals, `CAPTIONS_MAX_STREAMS=0`
   and channels whose effective setting is off; else take a slot from your own `SlotLimiter` (FIFO
   queue in start order, track row `queued` until then). Read audio with ffmpeg from `internalSrtUrl`
   with `-copyts` (never RTSP), 16 kHz mono; 3 s chunks; map chunk PTS to PDT with the media clock
   anchor the recorder uses; POST to `WHISPER_URL` with the spoken language. Mask through
   `@commonair/chat-filter` (patterns validated with `@commonair/safe-regex`): a match becomes a fixed
   language-neutral token, cue timing unchanged; unmasked text is never stored or logged. Whisper
   down or slow: drop that chunk, back off, keep the slot, count it in a metric; never block the ladder.
   `onEnd` (and on stream crash): release the slot, start the next queued stream; with a VOD, stitch
   the cues into `<vod storage_prefix>captions/<lang>.vtt` (your write must not race `vod-finalize`'s
   move; test it) and mark the track ready; with no VOD, delete the cues (ADR 0011 decision 6). Live
   cues sit in Valkey under keys from `packages/captions`, with a TTL that bounds a crash.
4. **Origin.** `captions.ts` serves the live subtitle playlist (with `EXT-X-PROGRAM-DATE-TIME`) and
   VTT segments (`X-TIMESTAMP-MAP` on the source clock) under the live path, token-checked like
   `/hls`; 404 for no active track; short `cache-control`. VTT fetches are not media: do not feed
   them to `SegmentLog`. `playlist.ts`: add `EXT-X-MEDIA:TYPE=SUBTITLES` (`DEFAULT=NO`,
   `AUTOSELECT=NO`) and the `SUBTITLES` attribute on every variant only while a track is active,
   surviving the data-mode variant filter and the audio-only variant.
5. **API.** `captionTracksFor(broadcast)` returns active tracks only (none for rehearsals);
   `vods.captions.get` follows the VOD's visibility; `update` (owner and channel editors) changes
   cue text only (timing fixed in v1), re-applies masking, writes `caption_edits` by user id, rewrites
   the stored track; validate with the contract schemas, `ORPCError` codes only.
6. **Player (`player/captions*`).** CC toggle (`IconButton` with tooltip, `data-state`), found through
   `onTextTrack`; turning it on calls `setTargetLatency(9)` (8–10 s, so cues land before their PDT),
   off restores the previous value; native HLS changes nothing (say so). Per-viewer size and contrast
   in `localStorage` (try/catch), `::cue` styled with theme tokens. When capacity is why captions
   are off, say so (needs the state, see contract requests).
7. **Studio (`_studio/captions.tsx`).** Enable toggle showing the instance default, spoken language
   (default `channels.language`), mask list (invalid pattern errors inline), live track state (active,
   queued for capacity, off), the per-VOD cue editor, and the draft privacy text on transcripts.
8. **Strings** in `w2-captions`, `en` and `es` in the same change (`bun run i18n:gen`).

## Tests you must add

- Unit: cue builder and VTT segmenter (PDT mapping, words across chunk edges, silence, empty and
  unicode text, `X-TIMESTAMP-MAP`); masking (case, word boundaries, regex, timing kept, no raw text
  retained, filter budget exceeded); queue order and release on crash; eligibility matrix (rehearsal,
  cap 0, default on/off, channel override); fetch-model (null digest and mismatch refused for
  captions, classifier unchanged); multivariant (no group without a track, attribute on every variant,
  namespaced groups, audio-only, data-mode filter); WER helper; player toggle (latency raise and
  restore, native no-op, `localStorage` throwing).
- Integration: the media worker against a fake whisper (`Bun.serve`) with real Postgres and Valkey
  (track rows, queue at cap, VOD track written under the prefix, cues dropped without a VOD);
  origin captions route (token, 404, headers); `vods.captions.update` (permissions, `caption_edits`,
  visibility) and `captionTracksFor`.
- Harness `captions` (fixture: 30–60 s synthetic TTS speech over a test pattern, CC0 or MIT, with a
  reference transcript; record the TTS tool and voice licenses in `<file>.license` sidecars, since
  `REUSE.toml` is not yours): SUBTITLES advertised; WER < 0.25 against the reference; every cue
  available before the playhead's PDT reaches it at 8–10 s latency (first-seen time of each cue in
  the subtitle playlist vs cue start + latency, plus a Chromium viewer whose `video.textTracks` shows
  cues); VOD captions present after the end; a second stream queued at the cap and started when the
  first ends; a VODs-off channel keeps no transcript; a rehearsal gets no track; a mask word masked.

## Contract requests to expect (file them with the exact diff if your base lacks them)

- Stubs `services/api/src/captions/{tracks,handlers}.ts` wired into `playback.start` (`captions:
  await captionTracksFor(b)`), the router and the `Vod` composer in `routes/vods.ts`; `packages/captions`
  scaffolding (`package.json`, workspace deps) and `@commonair/chat-filter` as a `services/media` dep.
- A capacity state the player can read (`PlaybackStart.captionsState: "off" | "queued" | "active"`)
  and a captions control slot in `apps/web/src/player/player.tsx` handing your component the controller.
- Who validates and persists the channel `captions` settings (mask patterns through safe-regex).
- If `moveVodObjects` does not move every object under the prefix, the `finalize.ts` change.

## Done means

Follow `.claude/briefs/_done-means.md`: `bun run test` / `test:int` in `services/media`,
`services/origin`, `services/api`, `packages/captions` (one `test:int` at a time); `bunx tsc -p` each;
`bun --bun vp test run` in `apps/web` and `harness`; `vp lint --deny-warnings` and `vp fmt` on your
paths; `vp build` in `apps/web`; `cd apps/web && bun run i18n:check && bun --bun vp test run
tests/i18n.test.ts`; `reuse lint`; `bun scripts/check-licenses.ts`. Never an image build, `podman
compose`, `scripts/infra.ts` or a scenario. `git status` shows only your paths; commit `git commit -s`.
Final message adds the ADR 0011 History text (model size and why) and what the user runs live:
`bun scripts/fetch-model.ts` with the captions flag, `bun scripts/pin-images.ts --write`, build the
whisper image, `bun scripts/infra.ts stack --harness`, `bun harness/src/cli.ts run captions`, then the
studio captions page and the player CC toggle under `en`, `es` and `en-XA`, 320 px, dark and light.
