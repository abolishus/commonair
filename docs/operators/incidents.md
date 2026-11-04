<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Incidents

An incident is anything that makes the instance unavailable or wrong for users: an outage, a
partial outage (chat, video or ingest down), data at risk, or a security event. Who is on call and
how they are reached is in [on-call.md](on-call.md#rota). This page is what that person does.

## Declaring an incident

Declare one when any of these is true:

- an outside-in problem mail arrived and the component is still down after a quick look;
- [CommonairSloBurnFast](monitoring.md#commonairsloburnfast) is firing;
- users report the same failure from more than one place;
- data may be lost or exposed (always an incident, even if the service is up).

Then:

1. **Say so** on the team channel: "Incident: <what is broken>, I am lead." The lead decides and
   communicates; others fix. One lead at a time; hand over explicitly.
2. **Post a status page note** within 15 minutes ([below](#the-status-page-note)).
3. **Look** in order: the status page (which components are down, since when), the Grafana
   Availability and App dashboards, the journal on the app droplet
   (`journalctl --user -u 'commonair-*' --since -30min`), `selfhost.sh status`, and DigitalOcean's
   status page for the region and the managed clusters.
4. **Mitigate before you fix.** Restart, roll back to the previous release
   ([upgrades.md](../self-hosting/upgrades.md)), or take a feature off. The root cause can wait for the write-up.
5. **Keep a timeline** as you go, in UTC: what was seen, what was done, by whom (role, not name, in
   anything public).
6. **Close it** when the components are operational and the cause is known or contained: resolve
   the note, then write it up.

Planned work is not an incident, but it is announced the same way: a `maintenance` note and the
maintenance file ([status-page.md](status-page.md#planned-maintenance)). It still spends the
budget.

## The status page note

Write the note on the monitoring droplet ([status-page.md](status-page.md#posting-a-note)). What to
write:

- **What users see**, not what broke inside: "Chat messages are not being delivered", not "Valkey
  primary failed over".
- **When it started**, in UTC, and **what is next**: "We are working on it; next update by 14:30
  UTC."
- **Update** at least every 30 minutes while it lasts, as a new `##` section with the time. Change
  `status` as it moves: `investigating`, `identified`, `monitoring`, `resolved`.
- **No personal data**: no user names, channel names, addresses or messages. No blame, and nothing
  that helps an attacker (versions under attack, internal host names).
- When resolved, a one-paragraph summary: how long, what was affected, that a write-up follows.

## Comms

- **The status page** is the one public source. Everything else links to it.
- **The instance's announcement channel** (the site banner, social accounts the instance runs): a
  short post for anything longer than 15 minutes or affecting most users, with the status page
  link.
- **Creators** with scheduled streams or ticketed events in the window: a direct message from the
  instance account once mitigated, including any refunds or make-goods the instance offers.
- **Data exposure**: the security process in `SECURITY.md` decides who is told and when, including
  any legal notification deadline. Do not announce details before it says so.

## Post-incident write-up

Within five working days, for every incident that paged or spent more than 10 minutes of the
budget. Blameless: describe systems and decisions, not people. Copy the template into the
instance's incident log (resolved notes on the status page link to the public version, if any):

```markdown
# <Date, UTC>: <what users saw>

## Summary

Two or three sentences: what happened, how long, who was affected.

## Impact

- Duration: <start>–<end> UTC (<minutes> min); budget spent this month: <minutes> of 43
- Components: <website / API and database / chat / video / ingest / certificate>
- Users affected: <rough share or count, no names>
- Data: <none lost / what was lost or exposed>

## Timeline (UTC)

- hh:mm: first signal (which alert, or a report)
- hh:mm: incident declared, status page note posted
- hh:mm: mitigation
- hh:mm: resolved

## Cause

What failed and why, as far as known. The trigger and the underlying condition.

## What went well, what did not

Detection, response, tools, docs.

## Actions

| Action | Kind (prevent / detect / respond) | Owner (role) | Due |
| ------ | --------------------------------- | ------------ | --- |
|        |                                   |              |     |
```

Review the actions at the next operators' meeting. An action that changes a threshold, a probe or a
runbook updates [monitoring.md](monitoring.md#alerts), [status-page.md](status-page.md#what-is-probed)
or this page in the same change.
