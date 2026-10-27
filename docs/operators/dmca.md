<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# DMCA notice and takedown

> **No lawyer has reviewed any of this.** The flow, the constants in `DMCA_RULES`, the email
> wording, the form statements and the seeded DMCA policy (`packages/db/src/legal/dmca_policy.md`)
> are an engineering reading of 17 U.S.C. § 512. Have counsel review them, and your own duties,
> before you rely on the safe harbor. Not legal advice.

The US Digital Millennium Copyright Act gives a service provider a "safe harbor" from liability
for what its users store (§ 512(c)) if it, among other things, has a designated agent, removes
material expeditiously on a complete notice, handles counter-notices, and has a reasonably
implemented policy to terminate repeat infringers (§ 512(i)). CommonAir builds the mechanics; the
paperwork and the judgement calls are yours.

The behaviour the code is tested against is in
[docs/testing/e7-selectors.md](../testing/e7-selectors.md) ("DMCA notice", "Your content", "DMCA
queue", and the `trust-safety` step 8 scenario). The rest of trust & safety is in
[trust-safety.md](trust-safety.md).

## Before you open the instance: the designated agent (§ 512(c)(2))

1. **Register a designated agent with the US Copyright Office** in its online DMCA Designated
   Agent Directory. The registration needs the service provider's name and address, the agent's
   name, address, telephone number and email, and the names the service is known by (your
   instance's domain and name). There is a small fee.
2. **Renew it every three years.** An expired registration loses the safe harbor for that period.
   Put the renewal date in your calendar.
3. **Publish the agent's contact details** on the instance. Set `DMCA_EMAIL` (see
   [configuration](../self-hosting/configuration.md)): it is the `{{contacts.dmca}}` address in
   the seeded DMCA policy and in every DMCA email, and notices may also arrive there by mail. A
   notice that arrives by email is entered by a moderator through `/dmca` (or handled by hand).
4. **Read and adapt the DMCA policy** linked from `/dmca` (the seeded, versioned `dmca_policy`
   legal document). It is marked as a draft until counsel approves a version of it.

## What the instance does, step by step

| When                                           | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A notice is filed (`/dmca`, § 512(c)(3)(A))    | Anyone can file, behind ALTCHA. Every statutory element is a field or its own checkbox (good faith; accuracy and authority under penalty of perjury). URLs are normalised and de-duplicated, then resolved to a VOD, clip or live broadcast on this instance; anything else stays an "unresolved" item for staff to handle by hand. Platform moderators are notified.                                                                                                                          |
| A moderator rejects it                         | For a notice that is incomplete or not about this instance. The claimant gets a `dmcaNoticeDecided` mail with the moderator's note, which should say what is missing: for a notice that identifies the work, the location and the contact details but lacks another element, this is the "reasonable steps to contact" of § 512(c)(3)(B)(ii).                                                                                                                                                  |
| A moderator actions it (§ 512(c)(1)(C))        | In one transaction: every resolved item is disabled (VOD or clip: `removed_reason = 'dmca'`, status kept; a live broadcast is ended and its VODs and clips disabled), the uploader gets one strike per notice, and the repeat-infringer check runs. Access is disabled at once: the material is hidden from everyone, the owner included. The `dmca-disable` job then moves its files under the private `moderation/dmca/` prefix, so a known media URL stops working too. Nothing is deleted. |
| The uploader is told (§ 512(g)(2)(A))          | `dmcaNoticeReceived` mail with a link to `/settings/copyright`, where they see the notice (the claimant's name and the work, never the claimant's contact details) and their items.                                                                                                                                                                                                                                                                                                            |
| The uploader counters (§ 512(g)(3))            | On `/settings/copyright`: name, address, telephone, the items, a statement, the penalty-of-perjury statement and the consent to jurisdiction and service of process. A confirmation tells them their name, address and phone go to the claimant. `restore_after` is set to 12 weekdays after receipt.                                                                                                                                                                                          |
| The claimant gets the counter (§ 512(g)(2)(B)) | `dmcaCounterNoticeForwarded` mail: a copy of the counter-notice (with the uploader's contact details, which is the one place they leave the instance), the restore date, and that the claimant must tell the designated agent about a court action before then.                                                                                                                                                                                                                                |
| The claimant files suit (§ 512(g)(2)(C))       | When the claimant tells the agent they filed an action to restrain the uploader, a moderator records it on `/admin/dmca` ("Record court action", with a note such as the court and case number). The material then stays down; the restore never runs for that counter-notice.                                                                                                                                                                                                                 |
| The waiting period ends                        | The `dmca-restore` job (every 15 minutes) moves the files back, then un-hides the material, reverses that notice's strike (`counter_notice_restored`), reverses a repeat-infringer termination that is now under the threshold, and mails the uploader `contentRestored`. A VOD that retention deleted meanwhile stays deleted.                                                                                                                                                                |

Every step writes an `audit_log` row (`dmca.notice.submit`, `dmca.notice.action` or
`dmca.notice.reject`, `dmca.counter.receive`, `dmca.counter.suit_filed`, `dmca.content.restore`,
and `account.dmca_termination` for a suspension) and an internal event. Audit rows, events,
account actions, notifications and logs carry ids, enums and counts only: the claimant's and the
uploader's names, addresses, phone numbers, signatures, statements and notes stay on the
`dmca_notices` and `dmca_counter_notices` rows.

## The constants (`DMCA_RULES` in `packages/contracts/src/enums.ts`)

| Constant                 | Value | Meaning, and what changing it means                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `restoreWeekdays`        | 12    | Material comes back 12 weekdays (Monday to Friday, UTC) after the counter-notice. The statute says "not less than 10, nor more than 14, business days"; holidays are not modelled, and 12 weekdays stay inside that window even with two federal holidays in it. Going below 10 or above 14 breaks the statute.                                                             |
| `repeatInfringerStrikes` | 3     | Unreversed strikes in the window that suspend the account (a `dmca_termination` account action and a user suspension with reason `dmca_repeat_infringer`, appealable on `/settings/appeals`). `0` turns the automatic suspension off: every strike then only notifies platform moderators, who must apply your policy by hand. The statute requires a policy, not a number. |
| `strikeWindowDays`       | 365   | How far back strikes count.                                                                                                                                                                                                                                                                                                                                                 |

The constants are compiled in (a contract change), not instance settings: change them in a
release, never on a running instance, and update the policy text to match.

A strike is reversed when a counter-notice restores the content or an appeal overturns it; a
termination is reversed when the user drops below the threshold. Reversing the termination lifts
only the DMCA suspension: a moderation or T0 suspension in force is never taken over or lifted by
the DMCA flow. Withdrawn notices are not modelled: if a claimant withdraws a notice, reverse the
strike through an appeal.

## Recording a court action

On `/admin/dmca`, filter by "Countered", open the notice, and on its counter-notice fill the
court action note and press "Record court action". Do it as soon as the claimant tells the
designated agent, and before the restore date: after the material is restored the button is
gone, and you take it down again with a new decision (or by hand). The note stays on the
counter-notice and is visible to platform moderators only.

## Records and retention

DMCA records are records of a legal process, so they are kept:

- `dmca_notices`, `dmca_notice_items`, `dmca_counter_notices` and `account_actions` cannot be
  deleted by the application (migration 0025 revokes `DELETE` and the guards make removal,
  hiding and restore timestamps write-once).
- **Account deletion does not scrub counter-notices or account actions.** The uploader's own
  counter-notices (their name, address, phone and statement) stay, because they are part of a
  legal process the claimant may still act on; the privacy policy must say so. Audit rows and
  account actions reference users by id only.
- A user's data export includes their counter-notices and their account actions (`safety.json`).
- Hidden files stay under `moderation/dmca/` until restored. If a VOD expires by retention while
  it is down, its files stay in the private prefix; remove them by hand when the matter is closed.

Decide how long you keep these records (for example the limitation period for copyright claims,
three years in the US) and write it into your retention policy; nothing purges them
automatically.

## Testing hooks

`POST /internal/moderation/dmca-tick` (`{ asOf }`) runs the restore as of a given time. It
exists only while `MODERATION_TEST_HOOKS=true`, behind `INTERNAL_API_SECRET`, and answers 404
otherwise. Nothing else shortens the waiting period. The harness exercises the whole flow with
`bun harness/src/cli.ts run trust-safety --set steps=8` (and `--set via=api`).
