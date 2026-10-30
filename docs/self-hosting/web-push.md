<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Browser push notifications

Browser push lets a viewer get a phone or desktop notification when a channel they follow goes
live, even when no CommonAir tab is open. It is **off by default**. When you turn it on, each
viewer still has to turn it on, per browser, in their notification settings, and their browser
asks them for permission. The design is [ADR 0028](../decisions/0028-notifications.md),
decisions 1 and 6.

In-app notifications (the bell) and go-live emails do not need any of this. They work on every
instance.

## What push is, and who sees what

A browser cannot be reached directly. When a viewer turns push on, their browser asks **its own
vendor's push service** for an address (Chrome and Edge: Google's Firebase Cloud Messaging;
Firefox: Mozilla's autopush; Safari: Apple's push service) and hands that address to your
instance, with two encryption keys. When a followed channel goes live, your worker sends the
notification to that address, and the push service passes it on to the browser.

This is the one place where your instance talks to a service you do not run, and it is the
viewer's choice of browser, not yours, that decides which one. That is why push is opt-in twice:
by you, and by each viewer.

What the push service sees:

- **That a message went to that browser, and when.** It sees your instance's address (the
  sender) and the size of the message.
- **Not what it says.** Every message is encrypted to the browser's own key
  ([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)). Only that browser can read it.
- **Your public VAPID key and your general contact address.** Each request is signed with your
  instance's VAPID key ([RFC 8292](https://www.rfc-editor.org/rfc/rfc8292)) and names
  `mailto:` your instance's general contact, so the vendor can reach you if your sends cause a
  problem.

What a message holds: the channel name and the stream title, nothing else. A mature stream's
title is left out for viewers who have not confirmed they are 18 or over.

What your instance stores: the browser's push address and keys, **encrypted** with your
`AUTH_SECRET`, found by an HMAC of the address. They are never logged. A row is deleted when the
viewer turns push off, signs out in that browser, or the push service says the address no longer
works (HTTP 404 or 410), and after five refusals in a row (for example a subscription made for
another VAPID key). Each member can have at most ten browsers; an eleventh replaces the oldest.

## Turning it on

With the installer, as the `commonair` user:

```sh
sh ~/commonair/selfhost.sh upgrade --web-push                 # on
sh ~/commonair/selfhost.sh install --reinstall --web-push     # or with a reinstall
```

`--web-push` works on `install`, `upgrade` and `install --reinstall`. It sets `WEB_PUSH_ENABLED=true` in
`commonair.env`, and the setting is kept on later upgrades until you pass `--no-web-push`.
Without either flag nothing changes (push stays off on a first install).

By hand: set `WEB_PUSH_ENABLED=true` in `commonair.env` and restart `commonair-api` and
`commonair-worker` (see [Configuration](configuration.md#changing-a-value)).

Outbound HTTPS from the worker must reach the vendors' push services (port 443). Nothing inbound
is needed.

## The VAPID key pair

`VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` identify your instance to every push service. You do
not make them: `bun scripts/init-env.ts` (which the installer runs on every install and upgrade
with `--merge`) generates one pair if it is missing and never replaces an existing one. The API
and worker refuse to start with push on and the pair missing, and say so. The private key is only
given to the worker.

**Rotating the pair drops every subscription.** Each browser subscribed to your public key; a
push service refuses messages signed with another one. If you rotate it (delete both lines and
run `init-env --merge` again), the worker deletes each subscription after its fifth refusal, and
every viewer has to turn push on again in each browser. Rotate only if the private key leaked.

A `VAPID_PRIVATE_KEY` that is not a P-256 PKCS#8 key (truncated, or pasted with its PEM lines)
passes the startup check but stops every push: the worker logs "VAPID_PRIVATE_KEY cannot be
imported" and sends nothing until it is fixed. No subscription is deleted for it.

**Rotating `AUTH_SECRET` strands every subscription.** The stored addresses are encrypted with it.
The worker cannot read them after a rotation, so it logs an error and skips them; it does not
delete them, because the same error also means one worker was started with a different
`AUTH_SECRET` from the API, and those rows are still good. Stranded rows go when their owners turn
push off or sign out; viewers turn push on again to be reached. Every API and worker replica must
share one `AUTH_SECRET`.

Back up the pair with the rest of `commonair.env` ([Backups](backups.md)).

## Turning it off

`sh ~/commonair/selfhost.sh upgrade --no-web-push`, or `WEB_PUSH_ENABLED=false` and a restart. The settings
page then hides the push toggle and no push is sent, including go-lives already queued. Stored
subscriptions stay until their owners sign out or turn push off, so turning it back on later
reaches the same browsers.

## `WEB_PUSH_ALLOW_INSECURE_ENDPOINTS`

Leave it off. It lets the API accept `http://` push addresses and the worker send to private
networks, which only the test harness needs (its push endpoint is a local server). On a public
instance it would let a member point your worker at your own network.
