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
and moderation actions you take as a channel moderator. Live chat messages are saved with the
broadcast and replayed beside its VOD and clips; messages that were deleted or moderated are never
replayed, and people you block stay hidden from you in replay. Your list of blocked users is kept
until you remove them or one of you deletes the account.

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

**Channel features.** If you use a channel's interactive features, we keep your channel points
balance and its history, your poll votes, your prediction bets and payouts, the links you submit
as song requests, and your interactions with the channel's bot (commands you use that cost
points, and your requests). We process them only to run those features. They are kept as
described under "How long we keep it" and included in your data export (see "Export and
deletion").

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

## Notifications

When a channel you follow goes live, we tell you in the app. We email you about it only if you
turn go-live emails on, and only at an address you have verified; every such email has a
one-click unsubscribe link. You get at most one go-live notification per channel within a few
hours, however often the stream restarts. We delete notifications after 90 days, and go-live
notifications you have read after 30 days.

**Browser push** is off unless the operator offers it and you turn it on in a browser. Your
browser then gives us an address at its push service, which your browser's maker runs (for
example Google, Mozilla or Apple), and two encryption keys. We store them encrypted and delete
them when you turn push off, sign out in that browser, or the push service tells us they no
longer work. Each push message is encrypted so that only your browser can read it, and it holds
only the channel name and stream title. The push service learns that a message was sent to your
browser, and when, but not what it says.

**Discord.** A streamer can connect their channel to a Discord channel through a Discord webhook.
When they go live, we post their channel link and stream title there, and Discord's own terms
and privacy policy apply to that post. We store the webhook address encrypted and never show it
again.

## Captions, analytics and rehearsals

Draft: counsel has not reviewed this section.

**Captions.** If a streamer turns captions on, our own servers transcribe the stream's audio; no
outside service hears it. The transcript is kept and deleted with the VOD, or deleted when the
stream ends if the channel keeps no VODs. Corrections record which account made them.

**Streamer analytics.** Streamers see totals for their own broadcasts, built from playback
sessions and never naming a viewer. Groups of fewer than five sessions are not shown.
Minute-by-minute figures are kept for 90 days, then only totals. Each broadcast's audience totals
are also published as a signed statement anyone can check: counts only, with the breakdown of
what was left out sealed for the streamer and whoever they share it with.

**Rehearsals.** A streamer can rehearse privately and invite up to five followers, who watch
signed in. We record who was invited or removed, by account. A rehearsal is never counted as a
broadcast, and its recording is deleted after 24 hours.

## Giveaways and the member jury

Draft: not reviewed by counsel (none retained).

**Giveaways.** When you enter a giveaway we record your account, the giveaway and the time.
Publicly you appear only as a pseudonym computed from a secret per-giveaway salt that we never
publish. Only you can see which pseudonym is yours. If you win, you are notified in the app; the
streamer does not see your account unless you contact them. Entries are kept with the giveaway.
On account deletion they remain under your pseudonymized account, so published draws stay
verifiable.

**Member jury.** If you opt in, you may be drawn at random to an advisory panel that reviews
closed moderation cases.

- **What we keep:** when you opted in or out, your panel seat, and each vote (agree, disagree or
  unsure, plus a reason chosen from a fixed list).
- **What votes contain:** no free text. Votes are kept with the panel's records and are never
  published one by one; only per-rule totals of 10 or more are published.
- **What jurors see:** people involved in a case appear under a pseudonym that changes each
  panel; reporters are never shown. Images are blurred until you reveal them. Cases involving
  minors, intimate images or illegal-content matches are never shown.
- **Opting out:** you can opt out at any time; it applies from the next panel.
- **Deleting your account:** removes your opt-in. Your seats and votes stay with the panel's
  records, linked only to your pseudonymized account.
- **Authority:** the jury cannot change any decision.

## Watch rooms, moving channels and federation

Draft: not reviewed by counsel (none retained).

**Watch rooms.** Up to 8 people, by invitation, watch a live stream together and chat. We keep who
hosted and joined, when, and the room's messages. Players report their position to keep the room in
step; those reports last about a minute. Only members see the messages, not the streamer or channel
moderators. If a member reports the room, its messages and member list are copied into the report
for platform moderators and kept with it. Under-18s and adults never share a room, rooms on mature
streams are for adults, and without a valid birth date you cannot use rooms. We delete a room 30
days after it ends. Deleting your account deletes your room messages and memberships and ends rooms
you host.

**Moving a channel.** A follow made through a streamer's move link records the link, so the streamer
sees how many follows each link brought, not who. If you ask to be told when a channel you follow
moves, we send you one email when it does and then delete your request; the streamer never sees who
asked. A streamer can export a bundle of their channel's details, panels, emotes and schedule. It
holds no followers, chat or viewer data. A bundle from {{instanceName}} carries a signed statement
of the channel's standing (counts of upheld actions and copyright strikes, and whether it is
suspended or under a legal hold), with no personal data. An import records what was imported or
refused, checks every image like any upload, and deletes the uploaded file once applied.

**Twitch import.** Connecting Twitch for an import asks for no permissions. We use Twitch's token
once to read your public profile, channel details, emotes and schedule, then revoke it; it is never
stored. We keep what we read with the import record. Importing emotes requires you to confirm you
made the art or may use it here; we record when you confirmed and the wording shown.

**Federation.** Off unless the operator turns it on, and then off for each channel until its
streamer does. A federated channel can be followed from Mastodon and other fediverse servers. It
publishes only what its public page shows: name, description, images, go-live posts and links to
public VODs and clips. It never publishes the follower list, viewers or who made a clip. For each
remote follower we store their account address, handle and inbox, so we can deliver posts; the
streamer sees these and can remove any follower. We delete them when they unfollow, are removed, or
their server is blocked or unreachable for 7 days, or when the channel stops federating, is
suspended or is deleted. Requests from other servers are kept up to 7 days. When a post or a channel
is removed we ask the servers that have it to delete it, best effort: they may keep copies. The
operator can block servers.

## How long we keep it

- Playback sessions and integrity signals: only as long as needed to compute verified viewer
  counts, patronage and appeals, then deleted or aggregated.
- Server logs: short-lived, and without IP addresses, emails or tokens.
- Account data and content: until you delete them or your account.
- Chat messages: {{chatRetentionDays}} days, or longer while the broadcast's VOD exists, but
  never more than {{chatReplayMaxDays}} days (a report keeps the reported text as evidence).
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
