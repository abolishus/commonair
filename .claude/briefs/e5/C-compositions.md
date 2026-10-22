<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E5 co-op compositions: how pages set the spec's test ids

Written by unit C (merged `04da33a`). The boards in `packages/ui/stories/pages/` set every id this
way; copy them.

Import everything from `@commonair/ui/blocks/coop` except NoteDialog (`@commonair/ui/blocks/forms`). Parts take `DataAttributes = { [k: `data-${string}`]: string|number|boolean|undefined }`. Rule: the composition sets the raw values the spec names as data-* itself; the page adds data-testid (and any other data-*) through rest props on the root and through `itemProps`/`rowProps`/`…Props` on parts. Labels are always props (pass t()).

PAGE WRAPPERS: `PageContainer` spreads rest, so a page sets `data-testid="coop" | "membership" | "settings" | "admin-coop"` there. `/coop/council` sets `council` with data-term-id/-starts-at/-ends-at (empty when there is no term). `/coop/proposals/$id` sets `proposal` with data-proposal-id/-status/-kind/-affects-creators.

/coop

- Membership card: shadcn `Card data-testid="coop-membership-card" data-classes="streamer,viewer"`. Inside it, `Button render={<a href aria-label data-testid="coop-membership-link"/>}`.
- Open proposal: `ProposalCard data-testid="coop-open-proposal" data-proposal-id data-status data-kind` (rest props spread).
- Council member: `ListPanel` items[].attributes = {"data-testid":"coop-council-member","data-user-id","data-rank"} (new prop).
- Members by class: `BreakdownBar data-testid="coop-members-by-class" data-streamer data-viewer data-worker`.
- `GovernanceOutcomeList` for recent decisions.

MembershipList({ items: {id, memberClass, classLabel, status, statusLabel, basis, basisLabel, since?, exit?: ConfirmedAction}[], label, empty?, itemProps? })

- Each row sets data-membership-id, data-class, data-status, data-basis.
- Page: itemProps={{"data-testid":"membership-row"}}.
- ConfirmedAction = {label, confirmTitle, confirmDescription?, confirmLabel?, destructive?, onConfirm, onError?, disabled?, triggerProps?, dialogProps?}.
- Exit: exit.triggerProps={{"data-testid":`membership-exit-${class}`}}, exit.dialogProps={{"data-testid":"membership-exit-confirm"}}. The dialog's confirm button keeps `confirm-dialog-confirm`.

EligibilityList({ items: {memberClass, classLabel, eligible, statusLabel, basis: string|null, basisLabel?, progress: {label, have, need, unit, valueText}|null, detail?}[], itemProps? })

- Sets data-class, data-eligible ("true"/"false"), data-basis ("" when null), data-have/data-need/data-unit ("" when progress is null).
- Page: itemProps={{"data-testid":"membership-eligibility"}}.

ShareCard({ title, description?, status ("none"|SHARE_STATUSES), statusLabel, amount: Money|null, amountLabel?, note?, buy?: {label, onBuy, pending?, props?}, instructions?: ReactNode, locale? })

- Root sets data-status and data-cents ("" when amount is null).
- Page: data-testid="membership-share"; buy.props={{"data-testid":"membership-buy-share"}}. Omit `buy` to hide it.

ShareInstructions({ title, instructions, amount, amountLabel, reference, referenceLabel, copyLabel, copiedLabel, copyFailedLabel, paymentId, locale? })

- Sets data-reference, data-payment-id, data-cents. The reference is copyable (CopyField).
- Page: data-testid="membership-share-instructions"; pass it as ShareCard `instructions`.

/coop/proposals

- Wrap the list in `<div data-testid="proposals">`.
- Status filter: `ChoiceToggle data-testid="proposals-filter" wrap options=[{value, label, "data-testid":`proposals-filter-${value}`}]`, including "all".
- Empty: `EmptyState data-testid="proposals-empty"`.
- Each item: `ProposalCard data-testid="proposal-item" data-proposal-id data-status data-kind`.
- New proposal: `Button render={<a href aria-label data-testid="proposals-new"/>} nativeButton={false}`.
- `proposalStatusTone(status)` gives the badge tone.

/coop/proposals/new

- Form: `FormSection data-testid="proposal-form" actions={{saveLabel, saveProps:{"data-testid":"proposal-save"}}}` (saveProps is new).
- Title: `CharacterCountField inputProps={{"data-testid":"proposal-title"}}`.
- Body: `CharacterCountField multiline textareaProps={{"data-testid":"proposal-body"}}`.
- Affects creators: `SwitchField switchProps={{"data-testid":"proposal-affects-creators"}}`.

ProposalChangeEditor({ rows: {id, key ("" = none), value (JSON text), error?}[], keyOptions: {value, label, protected, "data-testid"?}[], onRowChange(id, patch), onRemove(id), onAdd(), labels: {key, keyPlaceholder, value, valueHint?, protected, remove, add, empty?}, disabled?, kind?: {kind, label, description?, props?}, rowProps?, keyTriggerProps?, valueProps?, removeProps?, addProps? })

- Each row sets data-key, and data-protected once a key is chosen.
- A key already used in another row is disabled. Add is disabled once every key is used.
- Page sets:
  - rowProps "proposal-change"
  - keyOptions[]."data-testid" = `proposal-change-key-${key}`
  - keyTriggerProps "proposal-change-key"
  - valueProps "proposal-change-value"
  - removeProps "proposal-change-remove"
  - addProps "proposal-change-add"
  - kind.props "proposal-kind" (ProposalKindBadge sets data-kind)

/coop/proposals/$id

- ProposalChangeSummary({ items: {key, label?, from, to, protected}[], labels: {from, to, protected, empty?}, itemProps? }): sets data-key and data-protected. Page: itemProps "proposal-change-summary".
- ProposalKindBadge({kind, label}): sets data-kind.
- Timeline: `Timeline data-testid="proposal-timeline" steps=[{id, label, meta, state, attributes:{"data-testid":`proposal-timeline-${status}`, "data-at": iso || ""}}]` (attributes is new).
- Author actions:
  - Submit: `ConfirmDialog trigger={<Button data-testid="proposal-submit">}`.
  - Edit: `Button render={<a aria-label data-testid="proposal-edit"/>}`.
  - Withdraw: `ConfirmDialog trigger={<Button data-testid="proposal-withdraw">}`.
- Comments: `CommentItem data-testid="proposal-comment" data-comment-id data-author-id`, inside `CommentList`.
- Composer: `CommentComposer data-textarea-testid="proposal-comment-body" data-submit-testid="proposal-comment-submit"`.

CouncilResponseCard({ stance, stanceLabel, title, body, publishedAt? })

- Sets data-stance. Page: data-testid="council-response".
- Missed response: `AlertCallout data-testid="council-response-missed" tone="warning"`.

CouncilRespondForm({ title, description?, stanceLabel, stances: {value, label}[], stance, onStanceChange, bodyLabel, bodyHint?, bodyPlaceholder?, body, onBodyChange, maxLength?, submitLabel, onSubmit({stance, body}), pending?, error?, stanceProps?, stanceItemProps?(value), bodyProps?, submitProps? })

- Rest props go on the `<form>`; page sets data-testid="council-respond".
- Page sets stanceProps "council-respond-stance", stanceItemProps → `council-respond-stance-${stance}`, bodyProps "council-respond-body", submitProps "council-respond-submit".
- Submit is disabled until a stance and a body are given. The body is trimmed.

VotePanel({ title, description?, choiceLabel, choices: {value, label, description?}[], myVote: string|null, myVoteText?, value?/onValueChange?, canVote, cannotVoteReason?, submitLabel, onSubmit(choice), pending?, participation?: ReactNode, groupProps?, choiceProps?(value), submitProps? })

- Root sets data-my-vote ("" when none) and data-can-vote. The choice is pre-selected from myVote.
- When canVote is false, the choices and submit are disabled and submit is aria-describedby the reason.
- Page: data-testid="vote-panel", groupProps {"data-testid":"vote-choice"}, choiceProps → `vote-choice-${value}` (lands on the radio), submitProps "vote-submit".

VoteParticipation({ voted, eligible, label, valueText, note? })

- Sets data-voted and data-eligible. Page: data-testid="vote-participation".
- It takes no yes/no props, so no running tally is possible.

TallyTable({ passed, outcomeLabel, reason?, rows: {scope, label, yes, no, abstain, eligible}[], checks: {rule, label, detail?, passed}[], labels: {caption, scope, yes, no, abstain, eligible, turnout, checks, checkPassed, checkFailed}, rowProps?, checkProps?, locale? })

- Root sets data-passed. Rows set data-scope/-yes/-no/-abstain/-eligible. Checks set data-rule and data-passed.
- Page: data-testid="tally", data-reason={tally.reason} (raw TALLY_REASONS string), rowProps "tally-row", checkProps "tally-check".
- Build rows from breakdown.memberWide (scope member_wide) and byClass.{streamer, viewer, worker}. Use check.detail as the threshold text.

/coop/council

- SeatList({ items: {userId, name, accent?, avatarUrl?, link?, rank?, score?, memberClass?, description?, trailing?}[], label, empty?, itemProps? }) sets data-user-id, plus data-rank/data-score/data-class when given.
  - Council: itemProps "council-member" with rank and score.
  - Board: itemProps "board-seat" with memberClass.
- Method: `KeyValueList data-testid="council-method" rows=[…]`.
- ElectionCard({ electionId, memberClass, status, statusLabel, title, description?, details?: KeyValueRow[], candidates: {userId, name, accent?, statement?, votes?, elected}[], labels: {candidates, elected, noCandidates?} }) sets data-election-id, data-class and data-status. Page: data-testid="election-item".

/coop/settings

- GovernanceSettingsList({ items: {key, description?, value, protected, updatedBy: {proposalId, label, link}|null, updatedAt?}[], labels: {protected, seeded, setBy}, itemProps? })
- Sets data-key, data-protected and data-updated-by ("" when seeded). Flat objects render key-value; anything else renders as JSON.
- Page: itemProps "setting-row".

/coop/patronage

- StatementList({ title, description?, items: {periodId, title, description?, status, statusLabel, amount, link}[], empty?, itemProps?, action?, locale? })
  - Items set data-period-id, data-status and data-cents.
  - Page: data-testid="patronage", itemProps "patronage-item", empty=`<EmptyState data-testid="patronage-empty">` (shown when items is empty).
- StatementView({ title, period?, status, statusLabel, total, surplus, formula, lines: {component, label, explanation, basis, pool?, share (0–1), amount, capApplied}[], inputs?: KeyValueRow[], labels: {total, surplus, formula, lines, share, amount, capApplied, inputs}, lineProps?, explanationProps?, inputsProps?, locale? })
  - Root sets data-status and data-cents (total). Lines set data-component, data-cents, data-share and data-cap-applied.
  - Page: data-testid="statement" data-period-id data-formula-version; lineProps "statement-line"; explanationProps "statement-line-explanation"; inputsProps {"data-testid":"statement-inputs","data-revenue-cents","data-hours","data-relay-bytes","data-viewer-hours"}.

/treasury

- Tabs: `PageTabs` in panel mode (value/onValueChange) with items[]."data-testid" "treasury-tab-shares" / "treasury-tab-patronage".
- ShareRefundsTable({ rows: {id, user: {id, name}, status, statusLabel, amount, since?, refund?: ShareRefundAction}[], labels: {caption, member, status, amount, since, actions}, empty?, rowProps?, locale? })
  - Rows set data-share-id, data-user-id, data-status and data-cents. Page: rowProps "treasury-share-row".
  - ShareRefundAction = NoteDialog props without trigger, plus {label, triggerProps}. Page: triggerProps "treasury-share-refund", noteProps "treasury-share-refund-note", submitProps "treasury-share-refund-submit". onSubmit(trimmedNote); a rejected promise keeps the dialog open and shows errorText.
- PatronageRunForm({ title, description?, labels: {start, end, timesHint?, surplus, surplusHint?, submit}, currency, values: {start, end, surplus}, onValuesChange, onSubmit(values), pending?, error?, startProps?, endProps?, surplusProps?, submitProps? })
  - start and end are datetime-local text; the page reads them as UTC. surplus is currency-unit text, empty = all available.
  - Page: data-testid="patronage-run-form" (rest goes to FormSection), startProps "patronage-run-start", endProps "patronage-run-end", surplusProps "patronage-run-surplus", submitProps "patronage-run-submit".
- PatronageRunResult({ title, description?, members, total, surplus, retained?, labels: {members, total, surplus, retained?}, locale? })
  - Sets data-members and data-cents. Page: data-testid="patronage-run-result" data-period-id.
- PatronagePeriodsTable({ rows: {id, period, status, statusLabel, members, total, computedBy: {id, name}|null, approvedBy, approve?: GuardedAction}[], labels: {caption, period, status, members, total, computedBy, approvedBy, actions}, empty?, rowProps?, locale? })
  - Rows set data-period-id, data-status, data-cents, data-computed-by and data-approved-by ("" when null). Page: rowProps "patronage-period-row".
  - GuardedAction = ConfirmedAction + disabledReason?. Page: approve.triggerProps "patronage-approve" on computed rows. Set approve.disabledReason when computedBy.id === me: the button is disabled (focusable) and aria-describedby the visible reason.

/admin/coop

- AppointWorkerForm({ title, description?, labels: {username, usernameHint?, minute, minuteHint?, submit}, values: {username, minute}, onValuesChange, onSubmit (trimmed), pending?, error?, usernameProps?, minuteProps?, submitProps? })
- Page: usernameProps "appoint-worker-username", minuteProps "appoint-worker-minute", submitProps "appoint-worker-submit". Wrap the page in PageContainer data-testid="admin-coop".

/transparency

- GovernanceOutcomeList({ items: {proposalId, title, link, status, kind, protectedLabel?, passed: boolean|null, outcomeLabel, reason?, month (YYYY-MM), decidedAt?}[], label, empty?, itemProps? })
  - Sets data-proposal-id, data-status, data-kind, data-passed ("" when null) and data-month. Page: itemProps "transparency-governance".
- Patronage per month: `DataTable rowProps={(r)=>({"data-testid":"transparency-patronage","data-month":r.month,"data-cents":r.cents})}`.

Other new props:

- ConfirmDialog `contentProps` puts data-* on the dialog.
- NoteDialog({ trigger, title, description?, noteLabel, noteHint?, notePlaceholder?, noteRequired?, maxLength?, submitLabel, cancelLabel?, destructive?, onSubmit(note), errorText?, onError?, contentProps?, noteProps?, submitProps? }).
- Tone helpers: proposalStatusTone, shareStatusTone, membershipStatusTone, patronageStatusTone, councilStanceTone, electionStatusTone.
