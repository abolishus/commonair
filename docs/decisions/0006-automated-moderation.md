<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0006: Automated content moderation

- Status: proposed
- Date: 2026-10-19

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
- **New dependencies** (the PDQ/TMK implementation, the classifier runtime and weights) go
  through `check-licenses` like any other.

## Open questions (resolved in the trust & safety slice)

- Matcher deployment: a native TypeScript PDQ implementation, or Meta's Hasher-Matcher-Actioner
  (BSD) as a container.
- The default classifier model and runtime, with license verified.
- The NCMEC filing flow per operator (ESP registration, manual filing versus the reporting API).
- Jurisdiction-specific duties beyond the above (UK OSA risk assessment, DSA transparency
  reports) and which belong in the operator guide.
