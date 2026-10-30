<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Data saver

On a metered or slow connection you can give the player a **data budget**: how many megabytes an
hour you are willing to spend on a live stream. The player then plays the best quality that fits
the budget, drops to audio only when even the lowest video does not, and shows you what it is
actually using. Why it works the way it does:
[feature-wins §4.6](../product/feature-wins.md) and
[ADR 0018](../decisions/0018-data-mode-claim.md).

## Turning it on

Under the player on a channel page, turn on **Limit data use** and pick a budget:

| Budget       | About           | What it usually plays                         |
| ------------ | --------------- | --------------------------------------------- |
| Audio only   | 50 MB an hour   | Sound only                                    |
| Low video    | 800 MB an hour  | Up to 480p                                    |
| Medium video | 1900 MB an hour | Up to 720p                                    |
| Custom       | 20 to 4000      | Whatever fits the number you type, in MB/hour |

The choice is saved on this device (in your browser's local storage); if the browser refuses
storage, it holds until you leave the page. When your browser says it wants to save data, or that
the connection is slow, the Audio only budget is selected for you, but data saver stays off until
you turn it on.

A change applies within about ten seconds, at the player's next check-in with the server. It
never restarts your session.

## What the budget does

The budget becomes a bitrate ceiling (megabytes an hour × 8 000 000 ÷ 3600, less about 15 % for
the container and the playlists). It is written into the signed playback ticket the player uses for
every request, so the server can apply it too:

- **The server only offers you the qualities that fit.** Below the ceiling, plus audio only. This
  is what makes the budget hold on iPhones and Safari, whose built-in player picks its own quality.
- **Low-latency polling is turned off.** In data saver the player loads whole segments and checks
  for new ones once per segment instead of several times a second. Each check downloads a list
  of segments, and for audio those checks can cost more than the audio itself. The stream runs a
  few seconds further behind live.
- **Sharing with other viewers (P2P) is off.** Uploading to peers would spend your budget.
- **You are served directly by this instance**, not by a volunteer relay or a CDN, because only
  this instance can tailor the list of qualities to you.

## The audio-only floor

Audio only is the lowest the player goes. It plays even when it costs more than your budget, and
the panel says so. How much audio costs depends on the channel:

- When the channel has enough viewers for the instance to make several qualities (by default 50),
  there is a 96 kbit/s audio-only rung: about 50 MB an hour.
- On a smaller channel only the streamer's own audio exists, usually 128 to 160 kbit/s: about 65
  to 85 MB an hour.

The estimate under the budget picker tells you what the stream you are watching costs at your
budget.

## What the meter counts

While data saver is on, **Data used** counts what the player downloaded in this session over HTTP: video and audio
segments and the playlists that list them. It does not count the web page, chat or images. The
rate next to it is measured over the last two minutes, and starts again when you change the
budget.

In Safari and on iPhones the built-in player downloads out of the page's sight. Where the browser
reports the media it decoded, the meter shows that (playlists not included); where it reports
nothing, the meter says it cannot tell.

## Where it does not apply

- **Watching behind live (DVR)** and **videos (VODs)** are served at the stream's original quality
  only, so there is nothing smaller to pick. The player says data saver does not apply there.
- **Embedded players** on other sites do not show the panel.

## Safari and iPhones: a short pause

The built-in player cannot change quality on request, so turning data saver on or off, or changing
the budget, reloads the stream there. Expect a pause of a second or two. In other browsers the
switch is seamless.
