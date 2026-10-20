<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0006: Automated content moderation

- Status: accepted (2026-10-20)
- Date: 2026-10-19, resolution 2026-10-20

## Context

Until now the plan relied on user reports and channel moderators (PLAN 3G) plus a "CSAM
hash-match hook" in the media service that nothing scheduled. That is not enough for live video:

- **Harm happens in real time.** A stream with few viewers may have nobody to report it, and a
  report after the fact does not undo exposure.
- **Legal duties.** In the US, a provider that learns of apparent CSAM must report it to NCMEC
  and preserve it (18 U.S.C. 2258A, extended to one year by the REPORT Act). The TAKE IT DOWN Act
  requires removing non-consensual intimate imagery (NCII) within 48 hours of a valid request.
  The EU DSA requires notice-and-action, and the UK Online Safety Act expects risk assessments
  and proactive technology such as hash matching. This ADR is not legal advice. Counsel reviews
  the flows before any public instance launches.
- **Survival.** Payment processors, hosts and app stores drop platforms that become vectors for
  CSAM or graphic violence. A single incident can end the co-op.
- **FOSS first.** The strongest detection tools (PhotoDNA, Thorn Safer, Google CSAI Match) are
  proprietary or access-gated. Industry hash lists (NCMEC, Tech Coalition, StopNCII) need
  membership. The platform must still run with none of them (AGENTS.md non-negotiable 3).

## Decision

1. **Automated moderation is a core platform function, not an add-on.** It runs on every instance
   by default. An operator can swap providers but cannot turn off the pipeline itself.
2. **What gets scanned.** `services/media` samples one frame per live stream at stream start, then
   every `MODERATION_SAMPLE_SECONDS`, and enqueues a worker job. VODs, clips, thumbnails, and every
   user image upload (avatars, banners, emotes, panels) are scanned before they are published.
   Sampled frames live only in memory or a short-TTL object. Nothing is retained unless it is
   flagged.
3. **Two kinds of signal, both behind interfaces in a new `packages/moderation`:**
   - `HashMatcher`: perceptual hashes (PDQ for images, TMK+PDQF for video, both open source from
     Meta's ThreatExchange project) matched against operator-supplied lists, the same pattern as
     the datacenter CIDR lists (ADR 0003, D4). The FOSS default ships the matcher with an empty
     list. Industry lists and PhotoDNA, Safer or CSAI Match are optional adapters.
   - `Classifier`: per-category scores (sexual, graphic violence, weapons, self-harm). The default
     is an open-weight model run locally, chosen in the slice after its license and weights are
     verified at the pinned version. Hosted classifiers are optional adapters.
4. **Actions are tiered by confidence.** Only a known-illegal hash match acts without a human.

   | Tier | Trigger                                              | Automatic action                                                                                                     | Human step                                                                                   |
   | ---- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
   | T0   | match on a known-illegal list (CSAM, NCII)           | end the stream, suspend the account, hide its VODs and clips, put the evidence on legal hold, draft the NCMEC report | a designated staff member files the report. Dismissal needs two reviewers and is audited     |
   | T1   | classifier score above the prohibited threshold      | blur the stream for viewers behind an interstitial, remove it from the directory, put it at the top of the mod queue | a moderator clears it or escalates (warning, end stream, suspension) within the response SLA |
   | T2   | mature-content score on a stream not labelled mature | apply the mature label and the 18+ gate, notify the streamer                                                         | the streamer can appeal. A moderator reviews the appeal                                      |
   | T3   | anything below the thresholds                        | none. Aggregate metrics only                                                                                         | none                                                                                         |

   No ban ever comes from a classifier score alone. Every automated action writes an `audit_log`
   row and an `events` outbox row in the same transaction, records the model or list version
   that fired, and is reversible by a moderator, except the T0 legal hold.

5. **Legal floors are not governance settings.** T0 behaviour, the evidence hold and NCII handling
   live in code and database constants, outside `governance_settings`, so no vote can disable
   them. T1 and T2 thresholds and the sample interval are ordinary governance settings,
   range-checked by the settings trigger so they cannot be set to "off" (fail closed, as in
   ADR 0004 decision 8).
6. **Legal hold is enforced in the database** (AGENTS.md non-negotiable 8). A `moderation_holds`
   table references the user, the evidence objects and the reason. Triggers block deleting or
   pseudonymizing held rows, and the app role cannot lift a hold. Account deletion (ADR 0004)
   proceeds for everything else and leaves held evidence linked by id. Evidence objects go to a
   separate bucket whose app credentials cannot delete.
7. **NCII takedown requests** come through a public form with a 48-hour clock tracked by the
   worker. Removed content is hashed into a local block list so re-uploads match T0.
   StopNCII is an optional adapter.
8. **Moderator wellbeing and privacy.** The review UI shows flagged frames blurred and grayscale
   by default, click to reveal, with no autoplay audio. T0 material is never shown in the
   ordinary mod queue. Only a staff role with a legal need can view it. Logs carry ids, categories
   and scores, never frames or personal data.
9. **Testing never uses real harmful material.** Tests use synthetic images whose PDQ hashes go
   into a fixture list, and a scripted `Classifier` adapter in the harness. Integration tests run
   the real default classifier only on benign images, as a smoke test.

## Consequences

- **Compute cost.** PDQ is cheap on CPU. The classifier is the expensive part. One frame per
  stream every few seconds stays within CPU budget for small instances. Large instances need a
  GPU or a larger interval, and the load test measures this.
- **Coverage depends on the operator.** A self-hosted instance without hash-list membership gets
  only its local block list and the classifier. The operator guide says so plainly and explains
  how to apply for list access.
- **False positives are certain.** That is why T1 and T2 blur, label and queue but never ban, why
  every automated action can be appealed, and why the model version is recorded for review.
- **Evidence retention overrides deletion** for held material only. The privacy policy and the
  data-export flow disclose it.
- **New dependencies** (the PDQ/vPDQ port, the classifier runtime and weights; see ADR 0008) go
  through `check-licenses` like any other.

## Resolution of the open questions (2026-10-20)

Researched at the start of slice E4c. Dependency license judgments are recorded in
[ADR 0008](0008-trust-safety-licenses.md). **This is not legal advice.** The legal facts below
are what the flows are designed against. Counsel reviews the flows, the request forms and the
operator guide before any public instance launches.

**Decided by the user on 2026-10-20:** evidence in sealed append-only Postgres plus a
worker-only evidence bucket with a daily hash audit (Q4); explicit sexual content is prohibited
even behind the 18+ gate, suggestive content gets the mature label (Q2); unresolved NCII requests
are hidden automatically at 48 hours (Q6); the default classifier ships for sexual content only
(Q2). The rest of this section is the head agent's proposal, accepted with the ADR.

### What exists today (found in the code)

- `services/media/src/safety/` has a `HashMatcher` interface, but the default provider is
  `none` (a no-op that records nothing). The only other provider, `stub`, matches exact SHA-256
  digests, so a re-encoded or resized frame never matches. The "hash-checked first" thumbnail is
  checked by that no-op on every instance today.
- `quarantine.ts` moves a matched broadcast's objects to `quarantine/` **inside the media
  bucket** (copy, then delete the original) with the media service's own credentials. Anything
  holding those credentials can delete the evidence, and retention jobs share the bucket.
- `legal_holds` (user id, reason, released_at) has no triggers and nothing uses it.
- Uploads (avatar, banner, panel, emote, alert assets) are presigned PUTs straight to the media
  bucket, so nothing can be scanned before it is public.

E4c replaces all four. `HASH_MATCH_PROVIDER` and `HASH_MATCH_LIST_FILE` are removed: the
matcher always runs (decision 1).

### Q1. Matcher: a native TypeScript PDQ

**Decision.** A native TypeScript port of PDQ in `packages/moderation`, plus vPDQ-style video
matching (PDQ on frames sampled at one per second, the approach Meta's own HMA uses), instead
of TMK+PDQF. **Not** Hasher-Matcher-Actioner as a container.

- **License.** ThreatExchange is BSD-3-Clause at tag `hma-v1.1.7` (`LICENSE`, `pdq/`,
  `vpdq/LICENSE.txt`, `tmk/LICENSE.txt`), which is on our allowlist. The ported files keep
  Meta's copyright and carry a `BSD-3-Clause` SPDX license header. REUSE gets
  `LICENSES/BSD-3-Clause.txt`.
- **Why not HMA.** HMA 1.1.7 is a Python/Flask service with its own Postgres schema and
  **unpinned** pip dependencies (`flask`, `threatexchange>=1.2.16`, which pulls Pillow, `pdqhash`
  and `faiss-cpu`). Its Dockerfile hard-codes an x86-64 `LD_PRELOAD`. There is no pinned image we
  can list in `infra/image-licenses.json`, Pillow's MIT-CMU license is not on our allowlist, and
  the service duplicates our queue, audit and hold model. The matching itself is about 400 lines.
- **Why not `pdq-wasm`** (npm, BSD-3-Clause): it ships a compiled blob that a reviewer cannot
  audit line by line, for no gain at one frame per stream per interval.
- **Decoding without a new image library.** ffmpeg (already in the media image) decodes and
  scales every input (live frames, VOD/clip frames and uploads) to raw 8-bit luma or RGB. The
  PDQ code only sees raw pixels.
- **Correctness.** Tests port PDQ's reference regression vectors (`pdq/data/reg-test-input`,
  benign photos and expected hashes) and check exact output on raw luma inputs. Through the
  ffmpeg path they check a small Hamming distance, because decoders differ.
- **Matching rules.** A match is Hamming distance ≤ 31 of 256 (Meta's recommended threshold;
  a code constant, not a setting). Frames with a PDQ **quality below 50 are never matched**,
  since near-uniform frames (black screens, fades) have degenerate hashes that collide.
  Low-quality frames are still classified. Lists are loaded at start, reloaded on SIGHUP and on
  file change, keep the last good list on a parse error, and record a list version (sha256 of
  the file plus the entry count) that is written into every match.
- **Lists.** Operator-supplied files, empty by default (ADR 0003 D4 pattern). One file per
  category, `MODERATION_HASHLIST_CSAM` and `MODERATION_HASHLIST_NCII`, so the action and the
  NCMEC draft follow the list that fired. The **local block list** (decision 7: hashes of
  content staff removed as CSAM or NCII) lives in the database and is always loaded. StopNCII
  shares PDQ hashes, so a StopNCII adapter fits the same interface later.

### Q2. Default classifier: `AdamCodd/vit-base-nsfw-detector` on ONNX Runtime, sexual content only

**Decision.** The default `Classifier` adapter runs
[`AdamCodd/vit-base-nsfw-detector`](https://huggingface.co/AdamCodd/vit-base-nsfw-detector)
(the upstream ONNX export, int8 quantized, pinned to revision
`8587de998f441aac03fdd57a85d2e4cb808c7d64` of 2024-12-03, with a sha256 checked on load) with
`onnxruntime-node` 1.30.0 (MIT, released 2026-09-14) on CPU.

- It scores **one category, `sexual`** (SFW/NSFW). No candidate model for graphic violence,
  weapons or self-harm passed the license policy _and_ is fit for purpose (ADR 0008 lists what
  was rejected and why). Those categories are part of the `Classifier` interface, but the
  default adapter returns them as **not scored** (never as 0). The mod-queue UI and the operator
  guide say so plainly. Until an operator adds an adapter for them, they rely on user reports.
  This is a known coverage gap, not a hidden one.
- The weights' license is a model-card declaration (Apache-2.0, base model
  `google/vit-base-patch16-384` Apache-2.0, no LICENSE file in the repository). The training
  data (about 25,000 images) is undisclosed. This is recorded as a judgment call in ADR 0008.
- Weights are never committed to git. `bun scripts/fetch-model.ts` downloads the pinned revision
  and verifies its sha256, into a volume or the worker image at build time. Operators without
  internet access copy the file and set `MODERATION_CLASSIFIER_MODEL`. If the file is missing or
  its hash is wrong, the worker **refuses to start** (fail closed). It does not fall back to
  "no classifier".
- Input is RGB 384×384 from ffmpeg, so no image library is needed. Bun loading the
  `onnxruntime-node` N-API addon gets a smoke test on benign images in the unit's integration
  test. If Bun cannot load it, the fallback is the same adapter in a small Node sidecar. That
  changes the deployment, not the interface, and would come back to the user.
- `onnxruntime-node`'s postinstall script would download CUDA binaries from NuGet. Bun does not
  run it (the package is not in `trustedDependencies`), and the package works without it on CPU.
- Harness and tests use the `ScriptedClassifier` (scores chosen per channel). The real model
  runs in tests only on benign images.
- Hosted classifiers (and any operator-chosen model for the missing categories) are optional
  adapters behind the same interface.

**Mapping to tiers (proposed defaults, governance-tunable inside the trigger's ranges).**
`sexual ≥ T2` (default 0.80, range 0.50–0.95) on a stream not labelled mature → T2 mature label.
`sexual ≥ T1` (default 0.97, range 0.85–0.995) → T1 blur, delist and queue, whether or not the
stream is mature, because explicit sexual content is prohibited even behind the 18+ gate
(decided by the user). Other categories → T1 at their own T1 threshold once an adapter
scores them.

### Q3. NCMEC and other reporting bodies

**Facts the flow is built on** (18 U.S.C. 2258A as amended by the REPORT Act, Pub. L. 118-59,
2024). A US provider that obtains actual knowledge of apparent CSAM must report it to NCMEC's
CyberTipline as soon as reasonably possible. It must preserve the report's contents for **one
year** (it may keep them longer voluntarily to fight child exploitation), store them securely
following the NIST Cybersecurity Framework, and limit access to them. US law does not require
proactive scanning. The scanning is the co-op's own choice (decision 1).

**Decision.**

1. **The platform drafts, a person files.** A T0 match on the CSAM list (or a staff
   confirmation of CSAM from a report) creates an `ncmec_reports` draft in the same transaction
   as the hold. The draft holds what the CyberTipline asks for: incident time (UTC), incident
   type, the account (id, username, email, the IP hashes and raw IPs the platform still has),
   the stream/upload ids, the matched hash and list version, and the held evidence object ids.
   It references the account by id. Raw contact data is copied into the draft row itself, which
   is held and never pseudonymized (the legal duty outranks deletion).
2. **Who files.** Only the new **`legal` platform role** can see drafts and evidence. A legal
   staff member reviews the draft and files it, then records the CyberTipline report id and the
   filing time. That starts the one-year preservation clock. A draft that is not filed within
   24 hours raises an alert, and after 72 hours an incident row.
3. **Filing channel per operator.** **Manual filing is the default** and works for every
   operator: the legal user copies the draft into NCMEC's reporting for registered ESPs, and the
   UI gives a checklist and a structured export. The operator first **registers as an ESP with
   NCMEC**; the operator guide links the registration process and says it should be done before
   launch. The **CyberTipline Reporting API** (XML web service with a test environment, for
   registered ESPs) is an **optional adapter** behind a `CsamReporter` interface, built later.
   No credentials ship with the platform.
4. **Non-US operators** configure their national body as the reporting target, for example the
   UK's NCA once Online Safety Act s.66 reporting is in force, or a national INHOPE hotline. The
   draft format stays NCMEC's, and the guide says each operator must confirm their own duty with
   counsel.
5. **Preservation release.** Holds never expire on their own. One year after filing, the worker
   marks the hold "eligible for release". Only an operator CLI running as the database owner
   (`bun run --filter @commonair/db hold -- release <id> --reason …`, audited) can release it,
   never the app role and never a vote.

### Q4. Evidence storage (amends decision 6: Garage cannot enforce "no delete")

**Finding.** Garage v2.4.1 (our pinned S3) gives a key only `read`, `write` and `owner` on a
bucket. `write` includes DeleteObject and overwrite. Its S3 compatibility page lists no
versioning, no bucket policies and no object lock, and the object-lock pull request (#1479) was
closed unmerged in 2026-09. So "a bucket whose app credentials cannot delete" **cannot be
proven in Garage**.

**Decision.** Evidence is enforced at the lowest layer that can enforce it, which is the
database (AGENTS.md non-negotiable 8).

- **Images and frames go in Postgres.** Matched frames, the frames around a match, matched
  uploads and NCII-reported images are each at most 1 MiB. They go into an append-only
  `evidence_objects` table: triggers forbid UPDATE, DELETE and TRUNCATE for every role, and a
  hold can only be released by the owner CLI.
- **Sealed.** Each object is encrypted to the operator's evidence public key (X25519 ECDH +
  AES-256-GCM through WebCrypto, no new dependency). Media and worker hold only the public key,
  so the services that handle frames cannot read evidence back. Database dumps and WAL backups
  carry ciphertext only (the NIST CSF requirement). Only the api's legal-view handler has the
  private key (`EVIDENCE_PRIVATE_KEY`), and every view writes an `audit_log` row. A missing
  public key makes media and the worker refuse to start (fail closed).
- **Large media goes to the evidence bucket.** VOD and clip files of a matched broadcast go to a
  separate evidence bucket (`S3_BUCKET_EVIDENCE`), sealed the same way. Only the worker has its
  key: media, api and web never do. A sha256 manifest row per object sits in the append-only
  table. A daily worker job re-reads every held object, checks its hash and raises an incident
  and alert if one is missing or changed. **On Garage, loss of a large object by a compromised
  worker is detected, not prevented.** The operator guide says so plainly and documents the
  stronger setup for S3 stores that support it (AWS S3, Ceph RGW): Object Lock in COMPLIANCE
  mode with at least one year of retention, plus a bucket policy that denies
  `s3:DeleteObject*`, `s3:PutObjectRetention` and `s3:BypassGovernanceRetention` to the app
  principal. The contract step proves in Garage that the api and media keys cannot even read or
  list the evidence bucket, and proves in Postgres that the app role cannot delete, update or
  release.
- `quarantine.ts` stops moving objects within the media bucket. Matched content is copied to
  evidence first, then the public copies are deleted, so nothing derived from a T0 match stays
  servable.

### Q5. Other jurisdictions (what goes in the operator guide)

A new `docs/operators/trust-safety.md` (CC-BY-SA), headed **"Not legal advice. Have counsel
review these flows and your own duties before launching a public instance."** It covers:

- **US.** NCMEC ESP registration and filing (above), and preservation. **TAKE IT DOWN Act:**
  covered platforms must have had a plain-language NCII removal process since 2026-05-19, remove
  the content and known identical copies within 48 hours of a valid request, and the FTC
  enforces it. DMCA (already built). Not mentioned elsewhere: Section 230 does not cover federal
  criminal law.
- **UK Online Safety Act.** The illegal content risk assessment (Ofcom's register lists
  livestreaming as a risk factor) and its record. The children's access assessment, and the
  children's risk assessment if children are likely to use the service. Ofcom's codes: content
  moderation, reporting and complaints, hash matching for CSAM on services in scope.
  **Warning:** the existing 18+ gate is a self-declaration. Under the OSA it is **not "highly
  effective age assurance"**, so a UK-accessible instance that allows pornographic content needs
  a real age-assurance provider (an optional adapter, not built). Prohibiting explicit sexual
  content (Q2) keeps the default instance out of that duty, subject to counsel.
- **EU Digital Services Act.** Points of contact (Arts. 11–12) and a legal representative if the
  operator is outside the EU (Art. 13). Notice-and-action (Art. 16: the reports and NCII forms
  are built to it). Statements of reasons to the affected user (Art. 17), and for online
  platforms submission to the Commission's DSA Transparency Database. Internal complaints
  (Art. 20: appeals) and out-of-court dispute settlement (Art. 21). Notifying authorities of
  threats to life or safety (Art. 18). Transparency reports (Arts. 15/24, the harmonised
  templates). The micro/small-enterprise exemption (Art. 19) is noted. The platform generates
  the transparency report figures from `audit_log`, `reports` and `appeals` (a worker job and an
  admin export, E4c builds the data, the template mapping is a follow-up).
- **Everywhere.** Coverage depends on hash-list membership (how to apply to NCMEC, Tech
  Coalition and StopNCII lists, plus the IWF in the UK), a moderator response SLA for T1,
  moderator wellbeing, and the evidence-store limitation of Q4.

### Q6. Smaller points settled for the contract step

- **NCII 48-hour clock.** A valid request (identifies the content, says the requester is the
  depicted person or their authorized representative, a good-faith statement that it is
  non-consensual, contact details and an electronic signature) starts the clock at receipt. The
  worker alerts the queue at 24 hours and escalates at 36 hours. **At 48 hours, if staff have not
  decided, the content is hidden automatically** (fail closed on the legal floor; audited; the
  uploader can appeal), as the user decided. Removed content is hashed into the local
  block list as NCII, so re-uploads match T0. The 48 hours and the escalation points are code
  and database constants.
- **Sample interval.** `MODERATION_SAMPLE_SECONDS` (env, 2–60, default 10) and governance
  setting `moderation.sample_seconds` (trigger range 5–60, default 10). The effective interval
  is the **smaller** of the two, so neither the operator nor a vote can make sampling rarer than
  the other allows, and neither can turn it off. Frames are sampled at stream start and then
  every interval, independently of the 60 s thumbnail.
- **Where T0 acts.** Media computes PDQ itself (cheap) and on a match kicks the publisher
  _first_, as the current enforcer does, so a database outage cannot keep a matched stream on
  air. It then writes the sealed frame and enqueues the T0 job. The worker applies the T0
  transaction: suspension, hiding VODs and clips, the hold, the NCMEC draft, `audit_log` and
  `events`. It retries until that transaction lands and alerts if it cannot. The classifier runs
  in the worker, and frames for it pass through Valkey with a 60 s TTL and are never written to
  S3 unless flagged.
- **Uploads.** Presigned PUTs go to an unpublished `incoming/` prefix. A new
  `uploads.commit` step runs PDQ (T0 on a match, and the upload is rejected) and the classifier,
  then copies the object to its public key. Nothing in `incoming/` is ever served, and a
  lifecycle job deletes unflagged objects after 24 hours.
- **T0 dismissal.** Two different `legal` users who are not the subject, each with a reason. The
  suspension and hidden content come back only after the second, and the hold stays.
