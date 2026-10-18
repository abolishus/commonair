<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Security Policy

## Supported versions

CommonAir is pre-1.0. We fix security issues in:

| Version             | Supported |
| ------------------- | --------- |
| Latest release      | Yes       |
| `main`              | Yes       |
| Any earlier release | No        |

Self-hosters should run the latest release. Releases are signed with Sigstore
cosign and ship with provenance attestations and a CycloneDX SBOM, so you can
verify what you deploy.

## Reporting a vulnerability

**Do not open a public issue, discussion, or pull request for a security
problem.**

Email **security@commonair.tv**. Encrypted reports are welcome; ask in a first
message for our current public key if it is not published alongside this file.

Please include:

- What the issue is and what an attacker could do with it.
- The affected component (web app, a service, the relay node, an SDK) and the
  version or commit.
- Steps to reproduce, a proof of concept, or both.
- Any conditions required (configuration, account type, network position).
- Whether you have shared it with anyone else.
- How you would like to be credited, if at all.

## What to expect

| Step                | Target                                |
| ------------------- | ------------------------------------- |
| Acknowledgement     | Within 3 business days                |
| Triage and severity | Within 7 days                         |
| Status updates      | At least every 14 days until resolved |
| Public disclosure   | Coordinated with you; default 90 days |

We practice coordinated disclosure. We will agree a disclosure date with you,
normally no later than 90 days after your report. We may ask for more time if a
fix is complex, or disclose sooner if a fix ships early or the issue is being
actively exploited. Fixed issues are published as GitHub security advisories
and noted in the [CHANGELOG](CHANGELOG.md).

## Safe harbor

We will not pursue or support legal action against anyone who, in good faith:

- Reports a vulnerability to us through this process.
- Tests only against their own accounts, their own self-hosted instance, or
  accounts they have explicit permission to use.
- Avoids privacy violations, data destruction, and service disruption, and
  stops and reports as soon as they reach other people's data.
- Gives us reasonable time to fix the issue before disclosing it.

If someone else brings action against you for research that followed this
policy, we will make it known that your work was authorized. If in doubt about
whether something is in bounds, ask first.

## Scope

**In scope**

- All code in this repository: web app, services, relay node, packages, SDKs,
  container images, and release artifacts.
- The co-op's flagship instance at commonair.tv.

**Out of scope**

- Social engineering, phishing, or physical attacks against members, workers,
  or contributors.
- Volumetric denial-of-service or load testing against the flagship instance.
  Use the local harness (`harness/`) to test load instead.
- Third-party services the platform can integrate with (payment processors,
  CDNs, OAuth providers, object storage). Report those to their vendors.
- Instances run by other people. Report those to their operators, though we
  want to hear about any underlying bug in the code.
- Findings without a demonstrated security impact (missing headers with no
  exploit, version banners, self-XSS).

## Credit

With your permission, we credit reporters by name or handle in the security
advisory and the CHANGELOG. We do not currently run a paid bug bounty; the
co-op has no funds for one yet.
