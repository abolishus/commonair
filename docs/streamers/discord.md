<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Go-live posts in your Discord

You can have a short message posted to a channel of your Discord server every time you go live.
It is optional: nothing else on the platform needs it, and the instance runs the same without it.
It uses a Discord **channel webhook** you paste into the studio: no bot, no Discord app and no
sign-in to Discord. Why it works this way: [ADR 0028](../decisions/0028-notifications.md),
decision 5.

Discord is a third-party, proprietary service. What is posted there is covered by Discord's
terms, not only this instance's. If you would rather use open tools, see
[the open alternative](#the-open-alternative-eventsub) below.

## Set it up

1. In Discord, open **Server Settings → Integrations → Webhooks** (you need the _Manage
   Webhooks_ permission) and choose **New Webhook**.
2. Pick the channel the posts should go to. The name and avatar you give the webhook are what the
   posts show: the platform never overrides them.
3. Choose **Copy Webhook URL**. It looks like `https://discord.com/api/webhooks/<number>/<token>`.
4. In the studio, open the **Dashboard** (`/dashboard`) and find **Discord go-live posts**. Paste
   the URL and choose **Save webhook**.
5. Choose **Send a test post**. A message "Test from _instance_: go-live posts for _channel_ will
   appear here." should show up in that Discord channel within a minute. If it does not, the
   section shows what went wrong after a refresh.

The channel owner and the channel's editors can set, test and remove the webhook. Each change is
recorded in the channel's audit log (the URL itself never is).

**Treat the URL like a password.** Anyone who has it can post to that Discord channel. The
platform stores it encrypted, never shows it again (the field is always empty, even when one is
set) and never sends it anywhere but Discord. To change it, paste a new one; to stop, choose
**Remove webhook**. If you think the URL leaked, delete the webhook in Discord and make a new one.

## What is posted

When you go live, one message:

> **Your channel** is live: Your stream title https://_instance_/_your-channel_

- **Nobody is pinged.** Mentions are turned off for every post, so a title with `@everyone`,
  `@here` or a role mention shows as plain text and notifies no one.
- **Mature streams post no title.** When the broadcast or the channel is marked mature, the
  message is "**Your channel** is live (18+) _link_": a Discord channel is a public place.
- **Text and a link only.** No embeds and no images from the platform. Long titles are shortened
  to fit Discord's 2000-character limit; the link is always kept.
- **At most one post per cooldown.** Going live again within the go-live cooldown (four hours by
  default, set by the co-op's `notifications.goLive` setting) does not post again, the same rule
  as the bell, email and push notifications. Test posts do not count toward it.

## When something goes wrong

The section shows the last post's time and, when the last attempt failed, why:

| What it says                      | What happened                                  | What the platform does              |
| --------------------------------- | ---------------------------------------------- | ----------------------------------- |
| rate limited                      | Discord asked us to slow down                  | Retries after the wait Discord asks |
| could not reach Discord           | Discord was down or did not answer             | Retries a few times                 |
| the webhook no longer exists      | The webhook was deleted in Discord (404)       | Counts it (see below)               |
| Discord refused the webhook token | The token in the URL is wrong (401)            | Counts it (see below)               |
| refused by Discord                | Discord refused the message for another reason | Does not retry that post            |

**A deleted webhook removes itself.** After three such answers in a row (one per go-live or test,
so normally three go-lives), the webhook is removed from your channel and you get a notification
in the bell that links to the dashboard. Paste a new URL to start again. A successful post resets
the count.

## The open alternative: EventSub

Going live is a public event (`stream.online`) in the platform's EventSub API, so you can announce
it anywhere with free software instead of Discord, for example in a Matrix room or with a
self-hosted bot:

1. Register an app in the developer console (`/developer` in the studio).
2. Subscribe it to `stream.online` with condition `{ "broadcaster_user_id": "<your user id>" }`
   and a webhook transport pointing at your service (it needs no authorization from you: the
   event is public).
3. Have your service post to Matrix (or wherever you like) when the notification arrives.

The details, including signing and retries, are in [EventSub](../developers/eventsub.md).
