<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

> **Draft pending lawyer review.** This text is a working draft. It has not been reviewed by a
> lawyer and may change before it is final. Questions: {{contacts.privacy}}.

This policy explains what personal data {{instanceName}} keeps, why, for how long, and what you
can do about it. {{instanceName}} is a member-owned cooperative: we do not sell data, we do not
show targeted advertising, and we do not load third-party trackers, analytics, fonts or scripts.
Everything the site loads is served by us.

## What we keep

**Account data.** Email address, username, display name, password hash (or the sign-in provider
you chose), birth date (to enforce the minimum age and the 18+ gate for mature content), optional
profile picture and bio, settings, and which legal documents you accepted and when.

**What you publish.** Streams, VODs, clips, thumbnails, chat messages, follows, channel settings,
and moderation actions you take as a channel moderator.

**Viewing and integrity signals.** When you watch a stream we create a short-lived playback
session with a random device identifier, heartbeats (watch time, buffering, bytes delivered over
HTTP and peer-to-peer), the delivery source, and a coarse network classification (for example
"datacenter" or "residential"). These signals let us count only real viewers and stop viewbots,
because viewer numbers drive discovery, patronage and co-op membership.

**IP addresses.** We do not store raw IP addresses. Where we need to recognise the same network
(rate limits, integrity evidence, peer-to-peer swarms) we store a keyed hash (HMAC) of the address
or of its network prefix. The key is secret to this instance, so the hashes cannot be matched
against other services.

**Money.** If you subscribe, tip or receive payouts, we keep the ledger entries that accounting
and tax law require. Card details are handled by the payment provider, not by us.

**Support and safety reports.** Reports, appeals and correspondence you send us.

## Why we use it

To run the service you asked for, to keep it safe and fair (moderation, integrity, abuse
prevention), to run the cooperative (membership eligibility, votes, patronage), and to meet legal
obligations. We do not use your data for profiling or advertising.

## Who sees it

Other users see what you publish and your public profile. Channel moderators see chat and
moderation history for their channels. Co-op staff see what they need for support, moderation and
accounting, and their actions are logged. We use service providers (hosting, email delivery and,
if enabled, payments) under contracts that limit them to processing on our behalf. We disclose
data to authorities only when the law requires it, and we tell you unless the law forbids it.

## Peer-to-peer sharing

Your browser can exchange parts of a live stream with other viewers of it, so the co-op serves
less traffic. This is **off unless you turn it on**. If the operator made it the default, a notice
tells you before it first starts.

While it is on, **other viewers of that stream can see your IP address**: their browsers connect
to yours. They do not see your account, and our tracker keeps only keyed hashes. It is never used
on 18+ or restricted streams, and stays off on metered connections, phones and tablets, and in
data-saving mode unless you turn it on yourself. Switch it off at any time from the player or
your privacy settings; playback continues without it.

## How long we keep it

- Playback sessions and integrity signals: only as long as needed to compute verified viewer
  counts, patronage and appeals, then deleted or aggregated.
- Server logs: short-lived, and without IP addresses, emails or tokens.
- Account data and content: until you delete them or your account.
- Ledger, tax and governance records: as long as the law or the co-op's bylaws require.

## Export and deletion

You can download an export of your data from your account settings at any time.

You can delete your account from your settings. After a short grace period (during which you can
cancel) we delete your account data and content. Some records must be kept, such as ledger
entries, votes, and moderation and audit history. Those records refer to you only by an internal
id, never by name or email, so deleting your account **pseudonymizes** them: the id no longer
leads to you, but totals and history stay correct. Your deletion receipt lists what was kept and
why. Data under a legal hold is kept until the hold ends.

## Cookies and storage

We use only first-party cookies and browser storage. See the cookie and storage policy for the
details and your choices.

## Your rights

Depending on where you live you may have rights to access, correct, delete, restrict or object to
processing of your data, to data portability, and to complain to a data protection authority.
Most of these you can exercise yourself in your settings; for anything else write to
{{contacts.privacy}}. We answer within the time the law requires.

## Children

You must be at least {{minAge}} to create an account. If we learn that an account belongs to
someone younger, we delete it.

## Changes

We publish every version of this policy with its date. If a change affects how we use data you
already gave us, we tell you before it takes effect.
