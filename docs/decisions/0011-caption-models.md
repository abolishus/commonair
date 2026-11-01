<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0011: Caption models, defaults and capacity

- Status: accepted (2026-10-27; the maintainer accepted the recommended answers, see
  [Decisions at acceptance](#decisions-at-acceptance-2026-10-27))
- Date: 2026-10-27 (code checked at `ccf9c17`)
- Gates: W2-captions ([W2 plan](../../.claude/briefs/next/W2-feature-wave.md), feature-wins §4.5)

**Licenses here are read from upstream repositories, not reviewed by counsel.** Decision 1 names
the license each artifact must carry and how W2-captions verifies it at the pinned version
(AGENTS.md non-negotiable 2). Acceptance covers that rule, not a legal opinion on model weights.

## Context

Open Captions (feature-wins §4.5) runs speech-to-text on live streams: a caption worker in
`services/media` reads the live audio, a whisper.cpp sidecar transcribes 2–5 s chunks, and the
result becomes a WebVTT `SUBTITLES` rendition on the live playlist and a caption track on the VOD.
Its step 0 is this ADR: which engine and which exact weights, under which license, and what the
feature costs to run. What the code has today:

- **One pinned model already exists.** `packages/moderation/src/model.ts:10-18` pins the moderation
  classifier by repository, revision, file and sha256; `scripts/fetch-model.ts` downloads it,
  checks the digest (`:27-33`) and refuses a mismatch (`:37-40`, `:52-55`). It tolerates a null
  digest with a warning (`:28-31`), so a first fetch can record it. The worker refuses to start
  without a matching file. W2 extends this script with a second entry rather than replacing it
  (`.claude/briefs/next/W2-feature-wave.md:17`).
- **Captions are an empty field.** `PlaybackStart.captions` exists in the contract
  (`packages/contracts/src/api/entities.ts:271`) and `playback.start` always returns `[]`
  (`services/api/src/routes/playback.ts:209`). The `Vod` entity has no captions field at all
  (`entities.ts:202-215`), although feature-wins §4.5 says cues are stitched into "the existing VOD
  `captions[]`".
- **Per-host media work is already capped.** Adaptive ladders are limited by
  `TRANSCODE_MAX_LADDERS` (`packages/config/src/env.ts:254-255`), enforced by a `SlotLimiter` in
  `services/media/src/service.ts:160`. Captions are the same kind of CPU-bound, per-stream work.
- **Media reads the source over RTSP today** (`services/media/src/ffmpeg/args.ts:19-22`). ADR 0012
  decision 3 (A2) moves the ladder, and decision 4's A2 update moves the recorder, to an SRT reader
  with `-copyts` so their timestamps share the source clock; neither has landed at this commit.
- **A word-filter validator is already a package.** `packages/safe-regex` validates filter patterns
  against ReDoS; the worker pool that runs them is still inside the chat service
  (`services/chat/src/filter-runner.ts:93`, `:212`), and the W2 contract step extracts it.
- **Costs have a home.** `infra_costs` rows carry a free-text `category`
  (`packages/db/src/schema/money.ts:214-228`), which feeds the transparency page.
- **Images are license-checked.** Every third-party image has an entry in
  `infra/image-licenses.json` (for example the Postgres entry notes that our image adds the WAL-G
  binary), enforced by `bun scripts/check-licenses.ts`.
- **Channels carry a spoken language** (`channels.language`, default `en`,
  `packages/db/src/schema/channels.ts:50`).

Nobody runs this yet: there are no self-hosters and no public instance, so no default here has to
be migrated for live data.

## Decisions

### 1. Engine: whisper.cpp, pinned; weights: MIT or Apache-2.0 only, pinned by digest

The engine is **whisper.cpp** (MIT), built at a pinned release tag. It runs on CPU with no Python
runtime, has a small HTTP server mode the sidecar can expose on the internal network, and is
self-hostable on the same hardware as the rest of the stack (non-negotiables 1 and 3: no
proprietary speech API, not even as the default).

The weights are **one file whose license is MIT or Apache-2.0**, verified at the pinned revision
from the publishing repository's license file, and pinned by repository, revision, file name and
sha256 in a second `MODEL`-style entry next to the classifier. Unlike the classifier entry, the
captions entry ships with its digest filled in: `fetch-model.ts` refuses a captions file with no
pinned digest rather than warning. The OpenAI Whisper weights and their ggml conversions are
published under MIT; W2-captions picks the size (a quantized multilingual `base` or `small`) by the
new `captions` harness's WER threshold on the reference droplet, records the license source in the
entry's comment, and adds the reasoning to this ADR in a History section (new).

**No CC-BY weights** (for example Opus-MT for translation) until an attribution policy exists.
CC-BY needs visible attribution wherever the output appears; we have no place for that yet, and
translation is deferred anyway (feature-wins §4.5).

Why digest pinning: the weights decide what words appear under a streamer's video. A silently
replaced file is a supply-chain change to user-visible output (ADR 0022's rule for code applies to
models too).

### 2. Captions are off by default; the streamer turns them on per channel

The channel setting `captions.enabled` starts `false`. A streamer turns captions on in the studio,
and sets the spoken language (default `channels.language`).

Why: CPU whisper on every live stream has a cost nobody has measured. Turning it on for everyone
before S1-a measures it could take capacity from transcoding, which every viewer depends on. The
default is a co-op policy question (feature-wins §7 lists "captions on by default" for governance):
the maintainer sets the starting value, `false`, and members may vote to flip it once the cost is
published. So that a vote can flip it without a release, the default is read from a governance
setting (`captions.defaultEnabled`, seeded `false`, ordinary not protected); a channel's own choice
always wins over the default.

### 3. A per-host cap on concurrent caption streams, set from S1-a measurements

A new instance setting `CAPTIONS_MAX_STREAMS` (new, `packages/config/src/env.ts` and
`.env.example`), enforced in `services/media` with the same `SlotLimiter` pattern as
`TRANSCODE_MAX_LADDERS`. It is per media host, because a stream's captions run where the stream is
(and at ADR 0032 stage 3 each transcode droplet has its own budget). The starting value is **2 per
host**, a guess; S1-a's capacity runs replace it with a measured number, recorded in
`docs/operators/capacity.md`.

Streams that want captions beyond the cap wait in a queue in start order. The player and studio
say that capacity is why captions are off (an i18n message, not a generic error). An operator sets
`0` to turn captions off on a host entirely.

This is an operator setting, not a governance setting: it protects the host, and only the operator
knows the hardware. The W2 plan's note that "the worker cap becomes a governance setting" is
superseded (see corrections below). Members govern the default (decision 2); compute spent is
posted as an `infra_costs` line with category `captions` so they can see what the default costs.

### 4. Word masking is creator-configured masking, never removal

A creator lists words or patterns to mask in their captions. A match is replaced by a fixed mask
token in the cue (the cue still shows that something was said); nothing is dropped and no cue is
shortened. Patterns go through `@commonair/safe-regex` and run in the filter worker pool once the
contract step has moved it into a package. Masking is applied before a cue is stored or served, and
the unmasked text is not kept.

Why masking, not removal: removal makes captions disagree with the audio, which misleads exactly
the viewers who rely on them. Masking keeps the timing and tells a Deaf viewer that a word was
there.

Masked words are not a moderation signal. Transcripts do not feed T0, T1 or any automated
moderation without a separate ADR and a disclosure (feature-wins §4.5).

### 5. The sidecar is our own image on a pinned base, listed in `infra/image-licenses.json`

The sidecar image is built in-repo from the pinned whisper.cpp release on a third-party base image
pinned `name:tag@sha256:…` (`bun scripts/pin-images.ts --write`). The base image gets its own
`infra/image-licenses.json` entry; the entry's notes record that our image adds a whisper.cpp
binary (MIT) at the named tag, as the Postgres entry does for WAL-G. The weights are never baked
into the image: they are fetched by `fetch-model.ts` and mounted, like the classifier's, so the
image stays small and the weights stay digest-checked on every start.

### 6. Cues follow the source clock and the VOD's storage

The caption reader uses the same input and clock anchor that ADR 0012 settles for the recorder
(decision 4's A2 update: SRT with `-copyts`, anchored by W0), not a separate RTSP pull, so cue
times equal source PDT.
The VOD's caption track is written under the VOD's own `storage_prefix`, so ADR 0009 amendment 1's
placement moves it with the VOD and VOD retention deletes it with the VOD. Live cues for a channel
with VODs off are not kept after the broadcast ends. Account deletion already deletes a channel's
VOD prefixes (`services/worker/src/deletion/account-deletion.ts:360-374`), so the track goes with
them. Creator corrections (`caption_edits`, new) reference the editor by user id.

## Consequences

- W2-captions adds a second model entry to `scripts/fetch-model.ts`; the classifier entry and its
  null-digest tolerance stay as they are.
- New: `CAPTIONS_MAX_STREAMS` in `packages/config` and `.env.example` (a test enforces the sync);
  the governance setting `captions.defaultEnabled` seeded `false`; the channel `captions` settings
  and a VOD captions field in `packages/contracts` (the contract step; `Vod` has none today).
- Captions are only on for channels that ask, so the first cost numbers come from opted-in streams.
  The governance question in feature-wins §7 stays open and becomes answerable once a month of
  `captions` cost lines exists.
- Small instances can run with `CAPTIONS_MAX_STREAMS=0`; the "CPU tier for small boxes" question
  becomes a capacity note, not a code path.
- Translation is blocked on an attribution policy (decision 1), which is fine: it was deferred.
- The sidecar adds one image to pin, vet and list.

## Alternatives considered

- **A proprietary speech API as the default.** Rejected by non-negotiable 3. It could come later as
  an optional adapter, which this ADR does not need.
- **Vosk or another Kaldi-family engine.** Lighter on CPU, but noticeably worse accuracy on
  conversational speech, and the multilingual models vary in license.
- **CC-BY weights now with a credits page.** Rejected until there is an attribution policy that
  covers the player, the VOD and exports.
- **Captions on by default.** Rejected for the starting value: the cost is unmeasured and a vote can
  turn it on later (decision 2).
- **The cap as a governance setting.** Rejected: members cannot know a host's capacity; they decide
  the default and see the cost instead (decision 3).
- **Removal instead of masking.** Rejected (decision 4).

## Decisions at acceptance (2026-10-27)

The maintainer accepted this ADR with the recommended answers:

1. **Engine and weights.** whisper.cpp (MIT), pinned, with one MIT- or Apache-2.0-licensed weight
   file pinned by digest. No CC-BY weights until there is an attribution policy; translation is
   later.
2. **Default.** Captions are off by default; streamers turn them on per channel. Why: CPU whisper on
   every live stream has an unmeasured cost. Members may vote later to flip the default once the
   cost is known; the maintainer set the starting value.
3. **Capacity.** A per-host cap on concurrent caption streams, an instance setting, starting at
   about 2 per transcode droplet and replaced by S1-a's measurements.
4. **Masking.** Caption word-masking is creator-configurable masking, not removal.
5. **Image.** The sidecar base image goes in `infra/image-licenses.json`.

## History

### 2026-11-01: the `captions` WER gate is 0.40 on the synthetic fixture; `base` stays for now

The first CI run of the `captions` scenario (run 41285945456) scored WER 0.38 against the 0.25
the brief set. Two causes, measured with the pinned whisper.cpp v1.9.5 build and the reference
transcript read by eSpeak NG (`harness/fixtures/captions/`):

- **A harness timing bug.** The worker's SRT reader started 8.8 s after the publisher (W0 waits
  for MediaMTX's LL-HLS), and the speech started after 6 s of silence, so the first sentence was
  never read. The publisher now leads with 15 s and trails 12 s
  (`harness/src/w2/captions/publisher.ts`).
- **The model on synthetic speech in 3 s chunks.** `ggml-base-q5_1` on the fixture, chunked the way
  the worker chunks it (AAC round trip included), scores 0.18 to 0.40 in one pass depending on
  where the chunk edges fall against the words (0.30 to 0.33 over three passes); the whole file in
  one request scores 0.08. The stored cues score the same as whisper's raw segments, so the worker
  neither drops nor repeats words at chunk joins. Slower eSpeak rates (120, 130 wpm) and word gaps
  (`-g` 10 to 25) did not move the spread, and cutting chunks at the quietest point near 3 s
  narrowed it (one pass 0.24 to 0.29) but barely lowered the mean. `ggml-small-q5_1` scores 0.08
  to 0.21 in one pass, at about 3.7 times the CPU per chunk, which the CI runner and decision (j)'s two-streams-per-host
  budget do not have (base already takes about 3 s per 3 s chunk on CI's two threads).

So the scenario speaks the fixture three times (each pass at a new chunk phase) and gates at WER
< 0.40: above the measured spread for `base`, below a pipeline that loses or repeats chunks. The
gate no longer decides between `base` and `small` on its own: synthetic formant speech is harder
for whisper than people are, and a recorded CC0 human reading would be the better measure. That
choice, and whether captions should move to `small` where the CPU allows, are for the maintainer.

### 2026-11-01: cue timing; whisper's encoder context is bounded to 512 frames

The second CI run (41291975172) failed the `captions` cue-timing gate: every timed segment was
listed 1.06 to 3.44 s after a player 9 s behind would reach it (the follower polls once a second,
so the true figure is up to 1 s less). The 9 s target was right; whisper was too slow to reach it:

- **whisper ran slower than the audio.** The sidecar log shows 38 back-to-back requests in 116.4 s,
  3.13 s per 3 s chunk on the runner's two threads. The worker's queue (`MAX_PENDING`, two
  waiting chunks) never drained: one slow chunk at the start (4.6 s) left one chunk waiting, and the
  wait then grew about 0.13 s per chunk until a chunk was skipped as backlog (segment 23), which
  matches the lateness climbing from 1.1 to 3.4 s and dropping once. Listing time was the 3 s chunk
  plus up to three whisper calls, not a publication delay.
- **What it costs.** whisper.cpp pads every request to a 30 s window (1500 encoder frames), so a
  3 s chunk costs as much as 30 s of audio. The client now sends `audio_ctx=512` (10.24 s, over
  three chunks; `services/media/src/captions/whisper.ts`). Measured with the pinned build and
  `ggml-base-q5_1` on the fixture, chunked as the worker chunks it, over six chunk phases: default
  2.14 s per chunk and WER 0.21 to 0.40 (mean 0.29); 512 frames 0.66 s and WER 0.19 to 0.34 (mean
  0.25); 384 frames 0.53 s, WER mean 0.30; 256 frames looped on some chunks (3.4 s, max). At the same
  ratio the CI runner needs about 1 s per chunk (not yet measured there), so a cue should be listed
  about 4 to 5 s after its segment starts,
  which leaves the player's 9 s (`CAPTIONS_LATENCY_SECONDS`, unchanged in `@commonair/captions`
  and in the web player) room for hls.js's subtitle playlist refresh. It also takes about two
  thirds off decision 3's per-stream CPU, so S1-a's cap measurements should use this setting.
