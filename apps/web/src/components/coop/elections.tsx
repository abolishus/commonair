// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ChannelAvatar, RelativeTime, StatusBadge, formatNumber, useLocale } from "@commonair/ui";
import { electionStatusTone } from "@commonair/ui/blocks/coop";
import { KeyValueList } from "@commonair/ui/blocks/data";
import { Button } from "@commonair/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Checkbox } from "@commonair/ui/components/checkbox";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Textarea } from "@commonair/ui/components/textarea";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { classLabel, electionStatusLabel, type ElectionDto, type MemberClass } from "../../lib/coop.ts";
import { FormError } from "../form-error.tsx";
import { electionRefusal, electionRefusalText, electionRole, toggleApproval } from "./rules.ts";

/** `coop.elections.nominate`'s statement limit. */
export const STATEMENT_MAX = 5000;

export interface ElectionActions {
  /** Resolves once the API accepted the candidacy; the page reloads the elections. */
  onNominate: (electionId: string, statement: string) => Promise<void>;
  /** Resolves once the API accepted the ballot. */
  onVote: (electionId: string, candidateIds: string[]) => Promise<void>;
}

export interface ElectionItemProps extends ElectionActions {
  election: ElectionDto;
  /** null when signed out (read-only). */
  meId: string | null;
  /** The caller's active membership classes; null while unknown (no role shown). */
  classes: readonly MemberClass[] | null;
}

/**
 * One board election (`election-item`): dates, candidates (`election-candidate`), and for the
 * caller what the election offers: stand while nominating (`election-nominate`), an approval ballot
 * of at most `seats` while voting (`election-ballot`). Ballots are secret: no one's choices are
 * shown, and counts appear only once the API closes the election.
 */
export function ElectionItem({ election: e, meId, classes, onNominate, onVote }: ElectionItemProps): React.JSX.Element {
  const { locale } = useLocale();
  const role = electionRole(e, meId, classes);
  const ids = React.useId();
  const [nominating, setNominating] = React.useState(false);
  const [statement, setStatement] = React.useState("");
  const [selected, setSelected] = React.useState<string[]>([]);
  const [pending, setPending] = React.useState(false);
  const [voted, setVoted] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const nominate = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onNominate(e.id, statement.trim());
      setNominating(false);
      setStatement("");
    } catch (err) {
      setError(electionRefusalText(electionRefusal(err), e.seats));
    } finally {
      setPending(false);
    }
  };

  const vote = async () => {
    if (pending || selected.length === 0) return;
    setPending(true);
    setError(null);
    try {
      await onVote(e.id, selected);
      setVoted(true);
    } catch (err) {
      const refusal = electionRefusal(err);
      // A ballot cast earlier (another tab, a reload) counts as cast.
      if (refusal === "alreadyVoted") setVoted(true);
      setError(electionRefusalText(refusal, e.seats));
    } finally {
      setPending(false);
    }
  };

  const full = selected.length >= e.seats;
  return (
    <Card
      size="sm"
      data-testid="election-item"
      data-election-id={e.id}
      data-class={e.class}
      data-status={e.status}
      className="min-w-0"
    >
      <CardHeader>
        <CardTitle>{t("coop.elections.seat", { class: classLabel(e.class) })}</CardTitle>
        <CardAction>
          <StatusBadge tone={electionStatusTone(e.status)}>{electionStatusLabel(e.status)}</StatusBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <KeyValueList
          dense
          rows={[
            { term: t("coop.elections.seats"), value: formatNumber(e.seats, locale) },
            { term: t("coop.elections.nominationsClose"), value: <RelativeTime date={e.nominationsCloseAt} /> },
            { term: t("coop.elections.votingEnds"), value: <RelativeTime date={e.votingEndsAt} /> },
          ]}
        />
        <h3 className="text-xs font-medium">{t("coop.elections.candidates")}</h3>
        {e.candidates.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("coop.elections.noCandidates")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {e.candidates.map((c) => (
              <li
                key={c.user.id}
                data-testid="election-candidate"
                data-candidate-id={c.user.id}
                data-username={c.user.username}
                className="flex min-w-0 items-start gap-2"
              >
                <ChannelAvatar name={c.user.displayName} size="xs" decorative />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs">
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    <span className="wrap-anywhere">{c.user.displayName}</span>
                    {c.elected ? (
                      <StatusBadge tone="success" icon={Tick02Icon}>
                        {t("coop.elections.elected")}
                      </StatusBadge>
                    ) : null}
                  </span>
                  {c.statement ? <span className="wrap-anywhere text-muted-foreground">{c.statement}</span> : null}
                </div>
                {c.votes !== null ? (
                  <span className="shrink-0 text-xs tabular-nums">
                    {t("coop.elections.votes", { count: formatNumber(c.votes, locale) })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {role.kind === "notMember" && (
          <p className="text-xs text-muted-foreground">
            {t("coop.elections.notMember", { class: classLabel(e.class) })}
          </p>
        )}
        {role.kind === "standing" && <p className="text-xs">{t("coop.elections.youStand")}</p>}

        {role.kind === "canNominate" &&
          (nominating ? (
            <div className="flex flex-col gap-2">
              <Field>
                <FieldLabel htmlFor={`${ids}-statement`}>{t("coop.elections.statement")}</FieldLabel>
                <Textarea
                  id={`${ids}-statement`}
                  data-testid="election-nominate-statement"
                  rows={4}
                  maxLength={STATEMENT_MAX}
                  value={statement}
                  onChange={(ev) => setStatement(ev.currentTarget.value)}
                />
                <FieldDescription>{t("coop.elections.statementHint", { max: STATEMENT_MAX })}</FieldDescription>
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  data-testid="election-nominate-submit"
                  size="sm"
                  disabled={pending}
                  onClick={() => void nominate()}
                >
                  {t("coop.elections.nominateSubmit")}
                </Button>
                <Button variant="ghost" size="sm" disabled={pending} onClick={() => setNominating(false)}>
                  {t("coop.elections.cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              data-testid="election-nominate"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => {
                setError(null);
                setNominating(true);
              }}
            >
              {t("coop.elections.nominate")}
            </Button>
          ))}

        {role.kind === "canVote" &&
          (voted ? (
            <p data-testid="election-voted" className="text-xs">
              {t("coop.elections.voted")}
            </p>
          ) : e.candidates.length > 0 ? (
            <fieldset data-testid="election-ballot" className="flex flex-col gap-2">
              <legend className="text-xs font-medium">{t("coop.elections.ballotTitle")}</legend>
              <p className="text-xs text-muted-foreground">
                {t("coop.elections.ballotHint", { seats: formatNumber(e.seats, locale) })}
              </p>
              {e.candidates.map((c) => {
                const checked = selected.includes(c.user.id);
                const id = `${ids}-ballot-${c.user.id}`;
                return (
                  <Field key={c.user.id} orientation="horizontal">
                    <Checkbox
                      id={id}
                      data-testid={`election-ballot-${c.user.id}`}
                      checked={checked}
                      disabled={pending || (!checked && full)}
                      onCheckedChange={() => setSelected((s) => toggleApproval(s, c.user.id, e.seats))}
                    />
                    <FieldLabel htmlFor={id}>{c.user.displayName}</FieldLabel>
                  </Field>
                );
              })}
              <Button
                data-testid="election-ballot-submit"
                size="sm"
                className="self-start"
                disabled={pending || selected.length === 0}
                onClick={() => void vote()}
              >
                {t("coop.elections.ballotSubmit")}
              </Button>
            </fieldset>
          ) : null)}

        {error && <FormError>{error}</FormError>}
      </CardContent>
    </Card>
  );
}
