// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** P1-player: the P2P indicator, notice, dialog and privacy setting (p2p.*). That unit owns this file. */
export const p2pMessages = {
  "p2p.indicator.off": "Peer-to-peer sharing is off",
  "p2p.indicator.on": "Peer-to-peer sharing is on, looking for other viewers",
  "p2p.indicator.sharing": "Sharing with {peers} other viewers, {bytes} sent",
  "p2p.indicator.sharingOne": "Sharing with 1 other viewer, {bytes} sent",

  "p2p.disclosure": "Sharing with other viewers shows them your IP address.",

  "p2p.notice.text": "This player shares the stream with other viewers.",
  "p2p.notice.turnOff": "Turn off",
  "p2p.notice.dismiss": "Dismiss",

  "p2p.dialog.title": "Peer-to-peer sharing",
  "p2p.dialog.what":
    "Viewers who turn this on pass parts of the stream to each other, so the co-op sends less of it from its servers. Every part is checked against our servers before it plays.",
  "p2p.dialog.default": "Sharing is off unless you turn it on.",
  "p2p.dialog.defaultOn":
    "This instance turns sharing on for computers that are not on mobile data, unless you turn it off.",
  "p2p.dialog.gated": "Sharing never runs on 18+ or restricted streams.",
  "p2p.dialog.switch": "Share with other viewers",
  "p2p.dialog.perDevice": "Your choice is saved on this device.",
  "p2p.dialog.nextStart": "Sharing starts the next time a stream starts playing.",
  "p2p.dialog.stopped": "Sharing is off. The stream keeps playing from our servers.",
  "p2p.dialog.active": "Connected to {peers} other viewers. Sent {sent}, received {received}.",
  "p2p.dialog.activeOne": "Connected to 1 other viewer. Sent {sent}, received {received}.",
  "p2p.dialog.privacyPolicy": "Privacy policy:",

  "p2p.settings.title": "Peer-to-peer sharing",
  "p2p.settings.intro":
    "Pass parts of the streams you watch to other viewers of the same stream, so the co-op sends less from its servers. Never on 18+ or restricted streams.",
  "p2p.settings.perDevice": "This setting applies to this device only.",
  "p2p.settings.nextStart":
    "Turning it on takes effect the next time a stream starts playing; turning it off stops sharing at once.",
} as const;
