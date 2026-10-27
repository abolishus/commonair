<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Trust & safety for operators

> **Not legal advice. Have counsel review these flows and your own duties before launching a
> public instance.**

This guide tells an operator what the trust & safety pipeline does, what it needs from you, and
which legal duties it is built to help with. The design and its reasoning are in
[ADR 0006](../decisions/0006-automated-moderation.md) (with its "Resolution of the open
questions") and the license review in [ADR 0008](../decisions/0008-trust-safety-licenses.md).
The behaviour the code is tested against is [docs/testing/e4c-selectors.md](../testing/e4c-selectors.md).

## What runs, and what you cannot turn off

The pipeline is always on. No environment variable, governance vote or admin setting disables
it; a missing or invalid setting makes the service refuse to start. You choose providers and the
sample interval, nothing else.

| Tier | Trigger                                                                | What happens automatically                                                                                                                                                |
| ---- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0   | A PDQ hash match against a CSAM or NCII list (or the local block list) | Stream cut, account suspended, VODs and clips taken down, evidence sealed and held, NCMEC draft for CSAM. Only the `legal` role sees the case. Dismissal needs two people |
| T1   | Classifier score above the T1 threshold                                | Stream blurred and delisted, case queued for a moderator. Never a ban                                                                                                     |
| T2   | Classifier score above the T2 threshold                                | Mature label applied (the 18+ gate). Never a ban                                                                                                                          |

No account is ever banned on a classifier score alone. Every automated action writes an
`audit_log` row and an `events` row in the same transaction, recording the list or model
version that fired.

## Configuration

| Variable                                                   | Services           | Notes                                                                                                                          |
| ---------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `MODERATION_SAMPLE_SECONDS`                                | media, worker      | 2–60, default 10. The effective interval is the smaller of this and the governance setting `moderation.sample_seconds` (5–60)  |
| `MODERATION_HASHLIST_CSAM`                                 | media, api, worker | Host path to the CSAM PDQ list, one 64-character hash per line; comments begin with `#`. The shipped empty file is the default |
| `MODERATION_HASHLIST_NCII`                                 | media, api, worker | Host path to the NCII PDQ list, same format; the shipped empty file is the default                                             |
| `MODERATION_CLASSIFIER`                                    | worker, api        | `onnx` (default). `scripted` is refused unless test hooks are on                                                               |
| `MODERATION_CLASSIFIER_MODEL`                              | worker, api        | Host path to the verified model file. Its SHA-256 is checked when the classifier starts                                        |
| `MODERATION_TEST_HOOKS`                                    | all                | **Never on a public instance.** Harness only                                                                                   |
| `EVIDENCE_PUBLIC_KEY`                                      | media, worker      | Seals evidence. `bun scripts/init-env.ts` generates the key pair                                                               |
| `EVIDENCE_PRIVATE_KEY`                                     | api only           | Opens evidence for the `legal` view. Keep it out of every other service and out of backups of the environment                  |
| `S3_BUCKET_EVIDENCE`, `S3_EVIDENCE_ACCESS_KEY_ID`/`SECRET` | worker only        | The evidence bucket and its own key. The main storage key has no access to it                                                  |

Hash lists reload on `SIGHUP` and on file change. A list that fails to parse is rejected and the
last good list stays loaded.

**Update lists in place, or restart the services afterwards.** Each list is bind-mounted as a
single file, and a container keeps the file it was started with. Overwriting that file in place
(`cp new.pdq csam.pdq`, or `cat new.pdq > csam.pdq`) reaches the containers. If the file watcher
does not pick it up, send `SIGHUP`.
Replacing it with a new file (`mv new.pdq csam.pdq`, or an editor that saves a new copy) does not.
The containers then keep matching the old list, with no error. In that case, restart media, API
and worker. The local block list (content your staff removed, including NCII
takedowns) lives in the database and always loads, so the platform matches re-uploads even with
no external list configured.

### Container paths and read-only mounts

Compose mounts the two host hash-list paths read-only into media, API and worker. If the
variables are empty, Compose mounts `infra/moderation/empty-hashlist`, which contains no hashes.
Set the two variables in `.env` to absolute host paths when you configure operator lists; Compose
passes those files into fixed container paths. Keep separate CSAM and NCII lists and do not put
list contents in the repository.

The ONNX model is mounted read-only into API and worker. Fetch and verify the pinned model into
the default path, or configure a different host file with `MODERATION_CLASSIFIER_MODEL`:

```
bun scripts/fetch-model.ts
```

For Quadlet, create the default empty-list files (or install your separately managed operator
lists at those paths) and copy the verified model before starting the units:

```
install -D infra/moderation/empty-hashlist ~/.local/share/commonair/moderation/csam.pdq
install -D infra/moderation/empty-hashlist ~/.local/share/commonair/moderation/ncii.pdq
bun scripts/fetch-model.ts
install -D .cache/models/adamcodd-vit-base-nsfw-detector-8587de99-int8.onnx \
  ~/.local/share/commonair/models/adamcodd-vit-base-nsfw-detector-8587de99-int8.onnx
```

The units mount them read-only at the same container paths as Compose. Each source file must
exist before starting the services. The model loader checks its pinned SHA-256 and refuses a
mismatched model.

**The platform ships no industry hash lists.** Coverage of known CSAM and NCII depends on you
joining the programmes that share them (see "Everywhere" below) and pointing the variables
above at the files they give you. Lists in other formats must be converted to PDQ.

The classifier is an open-weight model that scores only sexual content. Other categories
(violence, self-harm) need an operator-chosen adapter behind the same interface.

## The `legal` role and evidence

Grant the `legal` platform role only to the people who handle CSAM reports. They alone see T0
cases, the evidence viewer and NCMEC drafts; every evidence view writes an `audit_log` row.

Evidence is sealed (X25519 + AES-256-GCM) to your evidence public key. Media and the worker hold
only the public key, so the services that handle frames cannot read evidence back, and database
dumps contain ciphertext only. **Keep the private key safe and backed up separately:** without
it, held evidence cannot be opened, even by you.

- **Images and frames** (at most 1 MiB each) go into the append-only `evidence_objects` table.
  Database triggers forbid update and delete for every role.
- **Large media** (VOD and clip files of a matched broadcast) go to the evidence bucket, sealed
  the same way, with a sha256 manifest row in the database. A daily worker job re-reads every
  held object and raises an incident if one is missing or changed.

### The limitation on Garage

Garage, the default object store, cannot deny delete to a key that can write (no object lock, no
bucket policies). **On Garage, loss of a large evidence object by a compromised worker is
detected by the daily audit, not prevented.** If your store supports it (AWS S3, Ceph RGW), use
the stronger setup for the evidence bucket:

- Object Lock in **COMPLIANCE** mode, with a default retention of at least one year.
- A bucket policy that denies `s3:DeleteObject*`, `s3:PutObjectRetention` and
  `s3:BypassGovernanceRetention` to the principal the worker uses.

### Legal holds

Holds never expire on their own. One year after an NCMEC report is filed, the worker marks the
hold "eligible for release". Only the operator CLI, running as the database owner, can release
it, and the release is audited:

```
bun run --filter @commonair/db hold -- list
bun run --filter @commonair/db hold -- release <id> --reason "<why>"
```

The application role and governance votes cannot release a hold.

## United States

- **NCMEC CyberTipline (18 U.S.C. 2258A, as amended).** A provider that
  obtains actual knowledge of apparent CSAM must report it to NCMEC as soon as reasonably
  possible, preserve the report's contents for one year, store them securely following the NIST
  Cybersecurity Framework, and limit access to them. The current statute includes amendments
  through Public Law 119-60 (2025). US law does not require proactive scanning; the pipeline
  scans because the co-op chose to. See [18 U.S.C. § 2258A](https://uscode.house.gov/us/usc/119-118/t18/s2258A/).
  - **Register as an ESP with NCMEC before launch.** Manual filing through NCMEC's reporting
    for registered ESPs is the default and works for every operator.
  - A CSAM match creates an NCMEC **draft**. A `legal` user reviews it, files it, then records
    the CyberTipline report id and filing time in the legal view. That starts the one-year
    preservation clock. An unfiled draft raises an alert at 24 hours and an incident at 72.
  - The CyberTipline Reporting API is a possible future adapter. No credentials ship with the
    platform.
- **TAKE IT DOWN Act.** Covered platforms must provide a plain-language NCII removal process
  (in force since 2026-05-19) and remove the content and known identical copies within 48
  hours of a valid request; the FTC enforces it. The `/takedown` form and the NCII queue are
  built to it: the clock starts at receipt, the queue is alerted at 24 hours and escalated at
  36, and **at 48 hours undecided content is hidden automatically**. Removed content is hashed
  into the local block list so re-uploads match. See the [FTC's business guidance](https://www.ftc.gov/business-guidance/resources/complying-take-it-down-act).
- **DMCA.** The notice (`/dmca`), takedown, counter-notice, restore and repeat-infringer flow is
  built; the safe harbor also needs a designated agent registered with the US Copyright Office
  and a published policy. See [DMCA notice and takedown](dmca.md) (not reviewed by a lawyer).
- Section 230 does not cover federal criminal law.

## United Kingdom (Online Safety Act)

- The illegal content risk assessment and its record. Ofcom's risk register lists livestreaming
  as a risk factor.
- The children's access assessment, and the children's risk assessment if children are likely
  to use the service.
- Ofcom's codes: content moderation, reporting and complaints, and hash matching for CSAM on
  services in scope.
- **The built-in 18+ gate is a self-declaration. It is not "highly effective age assurance".** A
  UK-accessible instance that allows pornographic content needs a real age-assurance provider
  (an optional adapter, not built). The default policy prohibits explicit sexual content, which
  is meant to keep the default instance out of that duty, subject to your counsel's view.
- **CSEA reporting.** From 7 April 2026, in-scope regulated user-to-user services must report
  detected CSEA content to the NCA through its Industry Reporting Portal, subject to the
  applicable scope and reporting rules. Services already reporting all detected CSEA content
  to NCMEC are not required to duplicate reports to the NCA; services outside that arrangement
  must register and submit reports in the required format and timeframe. The platform's NCMEC
  draft is not an NCA submission, so operators must maintain the applicable reporting path.
  See [Ofcom's current reporting guidance](https://www.ofcom.org.uk/online-safety/illegal-and-harmful-content/duty-to-report-child-sexual-exploitation-and-abuse-csea-content-know-the-rules-and-how-to-comply)
  and the [NCA portal](https://www.nationalcrimeagency.gov.uk/what-we-do/crime-threats/child-sexual-abuse-and-exploitation/the-child-sexual-exploitation-abuse-industry-reporting-portal).

## European Union (Digital Services Act)

- Points of contact (Arts. 11–12), and a legal representative if you are outside the EU (Art. 13).
- Notice and action (Art. 16): the report and NCII forms are built to it.
- Statements of reasons to the affected user (Art. 17), and for online platforms, submission to
  the Commission's DSA Transparency Database.
- Internal complaints (Art. 20: appeals) and out-of-court dispute settlement (Art. 21).
- Notifying authorities of threats to life or safety (Art. 18).
- Transparency reports (Arts. 15 and 24, on the harmonised templates). The platform keeps the
  data in `audit_log`, `reports` and `appeals`; mapping it to the templates is a follow-up.
- The micro and small enterprise exemption (Art. 19) may apply to you.

See the [Digital Services Act text](https://eur-lex.europa.eu/eli/reg/2022/2065/oj).

## Other jurisdictions

Configure your national body (for example a national INHOPE hotline) as the reporting target and
confirm your own duty with counsel. The draft format stays NCMEC's.

## Everywhere

- **Hash-list membership.** Apply to the NCMEC, Tech Coalition and StopNCII programmes (and the
  IWF in the UK) for the lists that give the T0 tier its coverage.
- **A moderator response SLA** for T1 cases, published to your community.
- **Moderator wellbeing.** Queue frames are blurred and grayscale until a moderator reveals one;
  T0 material never reaches the ordinary queue. Plan rotation and support for the people who do
  this work.
- **The evidence-store limitation** above, if you run on Garage.
